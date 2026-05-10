#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import WebSocket from 'ws';

const FALLBACK_API_URL = 'https://backend.quilt.sh';
const DEFAULT_CC_IMAGE_REF =
  'ghcr.io/ariacomputecompany/quilt-nightly-cc:latest';
const DEFAULT_CODEX_IMAGE_REF =
  'ghcr.io/ariacomputecompany/quilt-nightly-codex:latest';
const DEFAULT_RLM_IMAGE_REF =
  'ghcr.io/ariacomputecompany/quilt-nightly-rlm:latest';
const DEFAULT_AEGIS_IMAGE_REF =
  'ghcr.io/ariacomputecompany/quilt-nightly-aegis:latest';
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_ENV_FILES = ['.env', '.env.local'];
const ATTACH_HEARTBEAT_MS = 12_000;
const PROFILE_CC = {
  key: 'cc',
  flag: '--cc',
  displayName: 'Claude Code',
  executablePath: '/usr/local/bin/claude',
  defaultImageRef: DEFAULT_CC_IMAGE_REF,
  envImageRef: 'QUILT_NIGHTLY_CC_REF',
};
const PROFILE_CODEX = {
  key: 'codex',
  flag: '--codex',
  displayName: 'Codex',
  executablePath: '/usr/local/bin/codex',
  defaultImageRef: DEFAULT_CODEX_IMAGE_REF,
  envImageRef: 'QUILT_NIGHTLY_CODEX_REF',
};
const PROFILE_RLM = {
  key: 'rlm',
  flag: '--rlm',
  displayName: 'RLM',
  executablePath: '/bin/bash',
  defaultImageRef: DEFAULT_RLM_IMAGE_REF,
  envImageRef: 'QUILT_NIGHTLY_RLM_REF',
};
const PROFILE_AEGIS = {
  key: 'aegis',
  flag: '--aegis',
  displayName: 'Aegis',
  executablePath: '/bin/bash',
  defaultImageRef: DEFAULT_AEGIS_IMAGE_REF,
  envImageRef: 'QUILT_NIGHTLY_AEGIS_REF',
};
const PROFILES = [PROFILE_CC, PROFILE_CODEX, PROFILE_RLM, PROFILE_AEGIS];

/**
 * @typedef {Object} ApiRequestOptions
 * @property {string} method
 * @property {string} apiUrl
 * @property {string} path
 * @property {string | null} token
 * @property {unknown} [body]
 */

/**
 * @typedef {Error & {
 *   status?: number | string,
 *   requestId?: string | null,
 *   code?: string | null,
 *   payload?: unknown,
 *   backendMessage?: string,
 *   quiltNightlyLogged?: boolean
 * }} NightlyError
 */

function parseDotEnv(content) {
  const parsed = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const exportLine = line.startsWith('export ') ? line.slice(7).trim() : line;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(exportLine);
    if (!match) continue;

    const key = match[1];
    let value = match[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    value = value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");

    parsed[key] = value;
  }
  return parsed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  const env = parseDotEnv(content);
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function preparseEnvArgs(argv) {
  const out = { noEnv: false, envFile: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-env') out.noEnv = true;
    else if (a === '--env-file') out.envFile = argv[i + 1] || null;
  }
  return out;
}

function loadLocalEnv(argv) {
  const pre = preparseEnvArgs(argv);
  if (pre.noEnv) return;

  const cwd = process.cwd();
  for (const file of DEFAULT_ENV_FILES) {
    loadEnvFile(path.join(cwd, file));
  }

  if (pre.envFile) {
    loadEnvFile(path.resolve(cwd, pre.envFile));
  }
}

function defaults() {
  return {
    apiUrl: process.env.QUILT_API_URL || FALLBACK_API_URL,
    // Match quilt.sh auto auth precedence: API key first, then bearer token.
    token: process.env.QUILT_API_KEY || process.env.QUILT_TOKEN || null,
    startTimeoutMs: Number(process.env.QUILT_NIGHTLY_START_TIMEOUT_MS) || DEFAULT_START_TIMEOUT_MS,
    registryUsername: process.env.QUILT_NIGHTLY_REGISTRY_USERNAME || '',
    registryPassword: process.env.QUILT_NIGHTLY_REGISTRY_PASSWORD || '',
  };
}

function usage(d) {
  console.log(`quilt-nightly

Usage:
  npx quilt-nightly --cc [options]
  npx quilt-nightly --codex [options]
  npx quilt-nightly --rlm [options] [-- <command...>]
  npx quilt-nightly --aegis [options] [-- <command...>]

Options:
  --cc                     Launch a Claude Code container flow via API
  --codex                  Launch a Codex container flow via API
  --rlm                    Launch an RLM-ready container flow via API
  --aegis                  Launch an Aegis container flow via API
  -m, --mesh               Use the RLM mesh helper mode (only with --rlm)
  -s, --s, --swarm [n]     Launch an Aegis swarm (only with --aegis, default n=2)
  --name <name>            Container name (default: auto-generated)
  --keep                   Keep container after terminal exits
  --                       Pass a startup command into the attached shell
  --help                   Show this help

Automatic defaults (no flags needed):
  api_url=${d.apiUrl}
  cc_image_ref=${process.env.QUILT_NIGHTLY_CC_REF || DEFAULT_CC_IMAGE_REF}
  codex_image_ref=${process.env.QUILT_NIGHTLY_CODEX_REF || DEFAULT_CODEX_IMAGE_REF}
  rlm_image_ref=${process.env.QUILT_NIGHTLY_RLM_REF || DEFAULT_RLM_IMAGE_REF}
  aegis_image_ref=${process.env.QUILT_NIGHTLY_AEGIS_REF || DEFAULT_AEGIS_IMAGE_REF}
`);
}

function parseOptionalPositiveInt(argv, index, fallbackValue) {
  const raw = argv[index + 1];
  if (!raw || raw.startsWith('-')) {
    return { value: fallbackValue, consumed: 0 };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer after ${argv[index]}`);
  }
  return { value: parsed, consumed: 1 };
}

function parseArgs(argv) {
  const d = defaults();
  const args = {
    cc: false,
    codex: false,
    rlm: false,
    aegis: false,
    mesh: false,
    swarmCount: 0,
    profile: null,
    apiUrl: d.apiUrl,
    image: '',
    name: null,
    token: d.token,
    toolPath: '',
    startupCommand: [],
    startTimeoutMs: d.startTimeoutMs,
    registryUsername: d.registryUsername,
    registryPassword: d.registryPassword,
    keep: false,
    cleanup: true,
    envFile: null,
    noEnv: false,
    cols: null,
    rows: null,
    help: false,
  };

  let passthroughStart = -1;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      passthroughStart = i + 1;
      break;
    }
    if (a === '--cc') args.cc = true;
    else if (a === '--codex') args.codex = true;
    else if (a === '--rlm') args.rlm = true;
    else if (a === '--aegis') args.aegis = true;
    else if (a === '--mesh' || a === '-m') args.mesh = true;
    else if (a === '--swarm' || a === '--s' || a === '-s') {
      const parsed = parseOptionalPositiveInt(argv, i, 2);
      args.swarmCount = parsed.value;
      i += parsed.consumed;
    }
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--keep') {
      args.keep = true;
      args.cleanup = false;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (passthroughStart !== -1) {
    args.startupCommand = argv.slice(passthroughStart);
  }

  if ([args.cc, args.codex, args.rlm, args.aegis].filter(Boolean).length > 1) {
    throw new Error('Choose only one profile flag: --cc, --codex, --rlm, or --aegis');
  }
  if (args.cc) args.profile = PROFILE_CC;
  if (args.codex) args.profile = PROFILE_CODEX;
  if (args.rlm) args.profile = PROFILE_RLM;
  if (args.aegis) args.profile = PROFILE_AEGIS;

  if (args.mesh && !args.rlm) {
    throw new Error('--mesh/-m can only be used with --rlm');
  }
  if (args.swarmCount > 0 && !args.aegis) {
    throw new Error('--swarm/--s/-s can only be used with --aegis');
  }

  if (args.profile) {
    args.image = process.env[args.profile.envImageRef] || args.profile.defaultImageRef;
    args.toolPath = args.profile.executablePath;
    if (args.profile.key === 'rlm' && args.startupCommand.length === 0) {
      args.startupCommand = args.mesh ? ['quilt-rlm', 'mesh'] : ['quilt-rlm', 'shell'];
    } else if (args.profile.key === 'aegis' && args.startupCommand.length === 0) {
      args.startupCommand = args.swarmCount > 0
        ? ['quilt-aegis', 'shell', '--mode', 'headless', '--swarm-count', String(args.swarmCount)]
        : ['quilt-aegis', 'shell', '--mode', 'headless'];
    }
  }

  return args;
}

class MutedOutput extends Writable {
  constructor(delegate) {
    super();
    this.delegate = delegate;
    this.muted = false;
  }

  _write(chunk, encoding, callback) {
    if (!this.muted) {
      this.delegate.write(chunk, encoding);
    }
    callback();
  }
}

async function ensureApiToken(args) {
  if (args.token) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'No API key found. Set QUILT_API_KEY or QUILT_TOKEN, or run interactively to enter one.'
    );
  }

  const output = new MutedOutput(process.stderr);
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });

  try {
    process.stderr.write('[quilt-nightly] Enter your Quilt API Key: ');
    output.muted = true;
    const answer = await rl.question('');
    output.muted = false;
    process.stderr.write('\n');

    const token = String(answer || '').trim();
    if (!token) {
      throw new Error('API key is required.');
    }
    args.token = token;
  } finally {
    rl.close();
  }
}

function toWsBase(apiUrl) {
  if (apiUrl.startsWith('https://')) return apiUrl.replace('https://', 'wss://');
  if (apiUrl.startsWith('http://')) return apiUrl.replace('http://', 'ws://');
  return `wss://${apiUrl}`;
}

function authHeaders(token) {
  if (!token) return {};
  if (token.startsWith('quilt_sk_')) return { 'X-Api-Key': token };
  return { Authorization: `Bearer ${token}` };
}

function extractRequestId(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  return headers.get('x-request-id') || headers.get('X-Request-ID') || null;
}

function parseErrorBody(rawText) {
  let json = null;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch {
    json = null;
  }

  if (json && typeof json === 'object') {
    return {
      code: json.error_code || json.code || null,
      message: json.error || json.message || rawText || 'unknown error',
      requestId: json.request_id || null,
      payload: json,
    };
  }

  return {
    code: null,
    message: rawText || 'unknown error',
    requestId: null,
    payload: null,
  };
}

function summarizeBackendMessage(rawMessage) {
  const message = String(rawMessage || '').trim();
  if (!message) return 'request failed';
  const lower = message.toLowerCase();
  if (lower.includes('docker build failed')) {
    return 'container image build failed';
  }
  if (lower.includes('timed out')) {
    return 'operation timed out';
  }
  const singleLine = message.split('\n')[0].trim();
  return singleLine || 'request failed';
}

async function withHeartbeat(promise, message, intervalMs = 12_000) {
  const timer = setInterval(() => {
    process.stderr.write(`${message}\n`);
  }, intervalMs);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

/**
 * @param {ApiRequestOptions} options
 */
async function apiRequest({ method, apiUrl, path: apiPath, token, body }) {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}${apiPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(token),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const parsed = parseErrorBody(text);
  const json = parsed.payload || (text ? { raw: text } : null);
  const requestId = extractRequestId(res.headers) || parsed.requestId;

  if (!res.ok) {
    const summary = summarizeBackendMessage(parsed.message);
    /** @type {NightlyError} */
    const err = new Error(
      `${method} ${apiPath} failed (${res.status}${requestId ? `, request_id=${requestId}` : ''}): ${summary}`
    );
    err.status = res.status;
    err.requestId = requestId;
    err.code = parsed.code;
    err.payload = parsed.payload;
    err.backendMessage = summary;
    throw err;
  }

  return json;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForRunning(apiUrl, token, containerId, timeoutMs) {
  const start = Date.now();
  let startAttempted = false;
  while (Date.now() - start < timeoutMs) {
    const data = await apiRequest({
      method: 'GET',
      apiUrl,
      path: `/api/containers/${encodeURIComponent(containerId)}`,
      token,
    });

    const state = (data?.state || '').toLowerCase();
    if (state === 'running') return;
    if ((state === 'created' || state === 'stopped') && !startAttempted) {
      startAttempted = true;
      await apiRequest({
        method: 'POST',
        apiUrl,
        path: `/api/containers/${encodeURIComponent(containerId)}/start`,
        token,
      });
      await sleep(750);
      continue;
    }
    if (state === 'error' || state === 'failed' || state === 'exited' || state === 'stopped') {
      throw new Error(`Container entered non-running state: ${state}`);
    }

    await sleep(1000);
  }

  throw new Error('Timed out waiting for container to reach running state');
}

async function waitForOperation(apiUrl, token, operationId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await apiRequest({
      method: 'GET',
      apiUrl,
      path: `/api/operations/${encodeURIComponent(operationId)}`,
      token,
    });

    const status = String(data?.status || '').toLowerCase();
    if (status === 'succeeded') return data;
    if (['failed', 'cancelled', 'canceled', 'timed_out'].includes(status)) {
      throw new Error(
        `Operation ${operationId} failed: ${data?.error || data?.message || status}`
      );
    }

    await sleep(1000);
  }

  throw new Error(`Timed out waiting for operation ${operationId}`);
}

function terminalSize() {
  const cols = Number(process.stdout.columns) || 80;
  const rows = Number(process.stdout.rows) || 24;
  return { cols, rows };
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function startupInputForCommand(command) {
  if (!Array.isArray(command) || command.length === 0) return null;
  return `exec ${command.map((part) => shQuote(part)).join(' ')}\n`;
}

function makeSyncArchive(syncPath) {
  const resolvedPath = path.resolve(process.cwd(), syncPath);
  const stats = fs.statSync(resolvedPath);
  const tarArgs = stats.isDirectory()
    ? ['-C', resolvedPath, '-czf', '-', '.']
    : ['-C', path.dirname(resolvedPath), '-czf', '-', path.basename(resolvedPath)];
  const tarResult = spawnSync('tar', tarArgs, {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (tarResult.error) {
    throw tarResult.error;
  }
  if (tarResult.status !== 0) {
    const stderr = Buffer.isBuffer(tarResult.stderr)
      ? tarResult.stderr.toString('utf8')
      : String(tarResult.stderr || '');
    throw new Error(
      `tar failed while preparing --sync payload: ${stderr.trim() || 'unknown error'}`
    );
  }

  return {
    resolvedPath,
    content: Buffer.from(tarResult.stdout || []).toString('base64'),
  };
}

async function syncArchiveToContainer(apiUrl, token, containerId, syncPath, timeoutMs) {
  const archive = makeSyncArchive(syncPath);
  process.stderr.write(
    `[quilt-nightly] syncing ${archive.resolvedPath} into /workspace via archive upload\n`
  );

  const accepted = await withHeartbeat(
    apiRequest({
      method: 'POST',
      apiUrl,
      path: `/api/containers/${encodeURIComponent(containerId)}/archive`,
      token,
      body: {
        content: archive.content,
        path: '/workspace',
      },
    }),
    '[quilt-nightly] uploading archive and waiting for sync operation...'
  );

  const operationId = accepted?.operation_id;
  if (!operationId) {
    throw new Error('Archive upload did not return operation_id');
  }

  await withHeartbeat(
    waitForOperation(apiUrl, token, operationId, timeoutMs),
    `[quilt-nightly] waiting for archive sync operation ${operationId}...`
  );
}

async function deleteContainer(apiUrl, token, containerId) {
  try {
    await apiRequest({
      method: 'DELETE',
      apiUrl,
      path: `/api/containers/${encodeURIComponent(containerId)}`,
      token,
    });
    process.stderr.write(`\n[quilt-nightly] cleaned up container ${containerId}\n`);
  } catch (e) {
    process.stderr.write(`\n[quilt-nightly] cleanup failed: ${e.message}\n`);
  }
}

/**
 * @param {{
 *   apiUrl: string,
 *   token: string | null,
 *   containerId: string,
 *   cols: number,
 *   rows: number,
 *   toolPath: string,
 *   startupInput?: string | null
 * }} options
 */
function attachTool({ apiUrl, token, containerId, cols, rows, toolPath, startupInput = null }) {
  return new Promise((resolve, reject) => {
    const wsBase = toWsBase(apiUrl).replace(/\/$/, '');
    const params = new URLSearchParams({
      container_id: containerId,
      cols: String(cols),
      rows: String(rows),
      shell: toolPath,
    });
    if (token) params.set('token', token);

    const wsUrl = `${wsBase}/ws/terminal/attach?${params.toString()}`;
    const ws = new WebSocket(wsUrl, 'terminal');

    let settled = false;
    let rawEnabled = false;
    let ready = false;
    let heartbeat = null;
    let startupSent = false;
    const stdin = process.stdin;

    const onResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: Number(process.stdout.columns) || cols,
            rows: Number(process.stdout.rows) || rows,
          })
        );
      }
    };

    const onData = (chunk) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
    };

    const cleanupIO = () => {
      process.stdout.off('resize', onResize);
      stdin.off('data', onData);
      if (rawEnabled && stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    ws.on('open', () => {
      process.stderr.write('[quilt-nightly] terminal session connected\n');
      if (stdin.isTTY) {
        stdin.setRawMode(true);
        rawEnabled = true;
      }
      stdin.resume();
      stdin.on('data', onData);
      process.stdout.on('resize', onResize);
      onResize();

      heartbeat = setInterval(() => {
        if (!ready) {
          process.stderr.write('[quilt-nightly] waiting for terminal readiness...\n');
        }
      }, ATTACH_HEARTBEAT_MS);

      if (!startupInput) {
        startupSent = true;
      }
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ready = true;
        const output = Array.isArray(data)
          ? Buffer.concat(data.map((chunk) => Buffer.from(/** @type {any} */ (chunk))))
          : Buffer.from(/** @type {any} */ (data));
        process.stdout.write(output);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }

      if (msg.type === 'error') {
        cleanupIO();
        settled = true;
        ws.close();
        reject(new Error(`${msg.code || 'ERROR'}: ${msg.message || 'unknown websocket error'}`));
      } else if (msg.type === 'ready') {
        ready = true;
        if (!startupSent && ws.readyState === WebSocket.OPEN) {
          ws.send(Buffer.from(startupInput, 'utf8'), { binary: true });
          startupSent = true;
        }
      } else if (msg.type === 'exit') {
        cleanupIO();
        settled = true;
        ws.close();
        resolve(msg.code ?? 0);
      }
    });

    ws.on('unexpected-response', (_request, response) => {
      const status = response?.statusCode || 0;
      const requestId = response?.headers?.['x-request-id'] || response?.headers?.['X-Request-ID'];
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      response.on('end', () => {
        cleanupIO();
        settled = true;
        const parsed = parseErrorBody(body);
        const finalRequestId = requestId || parsed.requestId || 'unknown';
        /** @type {NightlyError} */
        const err = new Error(
          `terminal attach failed (status=${status}, code=${parsed.code || 'ERROR'}, request_id=${finalRequestId}): ${parsed.message}`
        );
        err.status = status;
        err.code = parsed.code || 'ERROR';
        err.requestId = finalRequestId;
        err.backendMessage = parsed.message;
        reject(err);
      });
    });

    ws.on('close', () => {
      if (settled) return;
      cleanupIO();
      settled = true;
      resolve(0);
    });

    ws.on('error', (err) => {
      cleanupIO();
      settled = true;
      reject(err);
    });
  });
}

function randomName(profile) {
  return `nightly-${profile.key}-${Date.now().toString(36)}`;
}

function profileAutoSyncEnabled(profile) {
  return profile.key === 'rlm' || profile.key === 'aegis';
}

function profileDefaultContainerCommand(args) {
  const profile = args.profile;
  if (profile.key === 'aegis' && args.swarmCount > 0) {
    return ['tail', '-f', '/dev/null'];
  }
  return ['tail', '-f', '/dev/null'];
}

function aegisWorkerContainerCommand(index) {
  const port = 7878 + index;
  return [
    '/usr/local/bin/quilt-aegis',
    'serve',
    '--mode',
    'headless',
    '--addr',
    `0.0.0.0:${port}`,
    '--profile',
    `swarm-${index}`,
  ];
}

async function ensureImageAvailable(args) {
  const pullBody = {
    reference: args.image || '',
    force: false,
  };
  if (args.registryUsername && args.registryPassword) {
    pullBody.registry_username = args.registryUsername;
    pullBody.registry_password = args.registryPassword;
  }

  process.stderr.write(`[quilt-nightly] ensuring OCI image is available: ${args.image}\n`);
  await withHeartbeat(
    apiRequest({
      method: 'POST',
      apiUrl: args.apiUrl,
      path: '/api/oci/images/pull',
      token: args.token,
      body: pullBody,
    }),
    '[quilt-nightly] pulling OCI image metadata/layers...'
  );
}

async function createManagedContainer(args, name, command) {
  process.stderr.write(`[quilt-nightly] creating container '${name}' via API\n`);
  process.stderr.write(`[quilt-nightly] launching with image ${args.image}\n`);

  const created = await withHeartbeat(
    apiRequest({
      method: 'POST',
      apiUrl: args.apiUrl,
      path: '/api/containers?execution=sync',
      token: args.token,
      body: {
        name,
        image: args.image || '',
        oci: true,
        command,
        strict: true,
      },
    }),
    '[quilt-nightly] waiting for container create/start...'
  );

  const containerId = created?.container_id;
  if (!containerId) throw new Error('API did not return container_id');
  process.stderr.write(`[quilt-nightly] container id: ${containerId}\n`);
  return containerId;
}

function validateArgs(args) {
  let parsed;
  try {
    parsed = new URL(args.apiUrl);
  } catch {
    throw new Error(`Invalid --api-url '${args.apiUrl}'`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`--api-url must use http:// or https:// (got ${parsed.protocol})`);
  }

  if (!Number.isFinite(args.startTimeoutMs) || args.startTimeoutMs < 1000) {
    throw new Error('--start-timeout-ms must be >= 1000');
  }

  if (
    (args.profile?.key === 'rlm' || args.profile?.key === 'aegis') &&
    !fs.existsSync(process.cwd())
  ) {
    throw new Error(`Current working directory is not accessible: ${process.cwd()}`);
  }

  if (args.swarmCount !== 0 && (!Number.isInteger(args.swarmCount) || args.swarmCount < 1)) {
    throw new Error('--swarm must be a positive integer');
  }

  if (args.cols !== null && (!Number.isFinite(args.cols) || args.cols < 20 || args.cols > 1000)) {
    throw new Error('--cols must be between 20 and 1000');
  }

  if (args.rows !== null && (!Number.isFinite(args.rows) || args.rows < 5 || args.rows > 1000)) {
    throw new Error('--rows must be between 5 and 1000');
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error('Interactive TTY required. Run from a terminal, not a non-interactive pipe.');
  }
}

/**
 * @param {{
 *   name: string | null,
 *   apiUrl: string,
 *   image: string,
 *   token: string | null,
 *   toolPath: string,
 *   startupCommand: string[],
 *   mesh: boolean,
 *   swarmCount: number,
 *   registryUsername: string,
 *   registryPassword: string,
 *   profile: typeof PROFILE_CC | typeof PROFILE_CODEX | typeof PROFILE_RLM | typeof PROFILE_AEGIS,
 *   startTimeoutMs: number,
 *   cols: number | null,
 *   rows: number | null,
 *   cleanup: boolean,
 *   keep: boolean
 * }} args
 */
async function runProfileFlow(args) {
  const profile = args.profile;
  const autoProfile =
    profile.key === 'rlm' && args.mesh
      ? { ...profile, key: 'rlm-mesh' }
      : profile.key === 'aegis' && args.swarmCount > 0
        ? { ...profile, key: 'aegis-swarm' }
      : profile;
  const name = args.name || randomName(autoProfile);
  const startupInput = startupInputForCommand(args.startupCommand);
  await ensureImageAvailable(args);

  if (profile.key === 'aegis' && args.swarmCount > 0) {
    return await runAegisSwarmFlow(args, name, startupInput);
  }

  const containerId = await createManagedContainer(
    args,
    name,
    profileDefaultContainerCommand(args)
  );

  let cleaned = false;
  const maybeCleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (args.cleanup && !args.keep) {
      await deleteContainer(args.apiUrl, args.token, containerId);
    }
  };

  const sigHandler = async () => {
    await maybeCleanup();
    process.exit(130);
  };

  process.on('SIGINT', sigHandler);
  process.on('SIGTERM', sigHandler);

  try {
    await waitForRunning(args.apiUrl, args.token, containerId, args.startTimeoutMs);
    if (profileAutoSyncEnabled(profile)) {
      await syncArchiveToContainer(
        args.apiUrl,
        args.token,
        containerId,
        process.cwd(),
        args.startTimeoutMs
      );
    }
    process.stderr.write(
      `[quilt-nightly] container running; launching ${profile.displayName} TUI...\n`
    );

    const size = terminalSize();
    const cols = Number.isFinite(args.cols) && args.cols > 0 ? args.cols : size.cols;
    const rows = Number.isFinite(args.rows) && args.rows > 0 ? args.rows : size.rows;
    process.stderr.write(
      `[quilt-nightly] opening terminal session (container=${containerId}, shell=${args.toolPath})\n`
    );
    process.stderr.write(
      `[quilt-nightly] terminal attach can take up to ~${Math.ceil(args.startTimeoutMs / 1000)} seconds\n`
    );

    const exitCode = await attachTool({
      apiUrl: args.apiUrl,
      token: args.token,
      containerId,
      cols,
      rows,
      toolPath: args.toolPath,
      startupInput,
    });

    await maybeCleanup();
    process.exitCode = typeof exitCode === 'number' ? exitCode : 0;
  } catch (err) {
    /** @type {NightlyError} */
    const nightlyErr = /** @type {NightlyError} */ (err);
    if (nightlyErr?.status || nightlyErr?.requestId || nightlyErr?.code) {
      process.stderr.write(
        `[quilt-nightly] operation failed (status=${nightlyErr.status || 'unknown'}, code=${nightlyErr.code || 'ERROR'}, request_id=${nightlyErr.requestId || 'unknown'}): ${nightlyErr.backendMessage || nightlyErr.message}\n`
      );
      nightlyErr.quiltNightlyLogged = true;
    }
    throw nightlyErr;
  } finally {
    process.off('SIGINT', sigHandler);
    process.off('SIGTERM', sigHandler);
  }
}

async function runAegisSwarmFlow(args, baseName, startupInput) {
  const leaderName = `${baseName}-0`;
  const containerIds = [];
  let cleaned = false;

  const maybeCleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (args.cleanup && !args.keep) {
      await Promise.all(
        containerIds.map((containerId) => deleteContainer(args.apiUrl, args.token, containerId))
      );
    }
  };

  const sigHandler = async () => {
    await maybeCleanup();
    process.exit(130);
  };

  process.on('SIGINT', sigHandler);
  process.on('SIGTERM', sigHandler);

  try {
    for (let index = 0; index < args.swarmCount; index += 1) {
      const name = `${baseName}-${index}`;
      const command = index === 0
        ? ['tail', '-f', '/dev/null']
        : aegisWorkerContainerCommand(index);
      const containerId = await createManagedContainer(args, name, command);
      containerIds.push(containerId);
      await waitForRunning(args.apiUrl, args.token, containerId, args.startTimeoutMs);
      await syncArchiveToContainer(
        args.apiUrl,
        args.token,
        containerId,
        process.cwd(),
        args.startTimeoutMs
      );
    }

    process.stderr.write(
      `[quilt-nightly] Aegis swarm ready (${args.swarmCount} containers); attaching to leader ${leaderName}\n`
    );
    const size = terminalSize();
    const cols = Number.isFinite(args.cols) && args.cols > 0 ? args.cols : size.cols;
    const rows = Number.isFinite(args.rows) && args.rows > 0 ? args.rows : size.rows;
    const exitCode = await attachTool({
      apiUrl: args.apiUrl,
      token: args.token,
      containerId: containerIds[0],
      cols,
      rows,
      toolPath: args.toolPath,
      startupInput,
    });

    await maybeCleanup();
    process.exitCode = typeof exitCode === 'number' ? exitCode : 0;
  } catch (err) {
    /** @type {NightlyError} */
    const nightlyErr = /** @type {NightlyError} */ (err);
    if (nightlyErr?.status || nightlyErr?.requestId || nightlyErr?.code) {
      process.stderr.write(
        `[quilt-nightly] operation failed (status=${nightlyErr.status || 'unknown'}, code=${nightlyErr.code || 'ERROR'}, request_id=${nightlyErr.requestId || 'unknown'}): ${nightlyErr.backendMessage || nightlyErr.message}\n`
      );
      nightlyErr.quiltNightlyLogged = true;
    }
    throw nightlyErr;
  } finally {
    process.off('SIGINT', sigHandler);
    process.off('SIGTERM', sigHandler);
  }
}

async function main() {
  try {
    loadLocalEnv(process.argv);
    const args = parseArgs(process.argv);

    if (args.help || !args.profile) {
      usage(defaults());
      process.exit(args.help ? 0 : 1);
    }

    validateArgs(args);
    await ensureApiToken(args);
    await runProfileFlow(args);
  } catch (err) {
    /** @type {NightlyError} */
    const nightlyErr = /** @type {NightlyError} */ (err);
    if (!nightlyErr?.quiltNightlyLogged) {
      process.stderr.write(`[quilt-nightly] error: ${nightlyErr.message}\n`);
    }
    process.exit(1);
  }
}

main();
