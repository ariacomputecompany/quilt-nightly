#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import WebSocket from 'ws';

const FALLBACK_API_URL = 'https://backend.quilt.sh';
const FALLBACK_CC_DOCKERFILE_URL =
  'https://raw.githubusercontent.com/ariacomputecompany/quilt-nightly/master/cc/Dockerfile';
const FALLBACK_CODEX_DOCKERFILE_URL =
  'https://raw.githubusercontent.com/ariacomputecompany/quilt-nightly/master/codex/Dockerfile';
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_ENV_FILES = ['.env', '.env.local'];
const ATTACH_HEARTBEAT_MS = 12_000;
const PROFILE_CC = {
  key: 'cc',
  flag: '--cc',
  displayName: 'Claude Code',
  executable: 'claude',
  fallbackImage: FALLBACK_CC_DOCKERFILE_URL,
  envImage: 'QUILT_NIGHTLY_CC_IMAGE',
  envPath: 'QUILT_NIGHTLY_CLAUDE_PATH',
  fallbackPathCandidates: ['/usr/local/bin/claude', '/usr/bin/claude'],
};
const PROFILE_CODEX = {
  key: 'codex',
  flag: '--codex',
  displayName: 'Codex',
  executable: 'codex',
  fallbackImage: FALLBACK_CODEX_DOCKERFILE_URL,
  envImage: 'QUILT_NIGHTLY_CODEX_IMAGE',
  envPath: 'QUILT_NIGHTLY_CODEX_PATH',
  fallbackPathCandidates: ['/usr/local/bin/codex', '/usr/bin/codex'],
};
const PROFILES = [PROFILE_CC, PROFILE_CODEX];

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
  };
}

function usage(d) {
  console.log(`quilt-nightly

Usage:
  npx quilt-nightly --cc [options]
  npx quilt-nightly --codex [options]

Options:
  --cc                     Launch a Claude Code container flow via API
  --codex                  Launch a Codex container flow via API
  --name <name>            Container name (default: auto-generated)
  --keep                   Keep container after terminal exits
  --help                   Show this help

Automatic defaults (no flags needed):
  api_url=${d.apiUrl}
  cc_image=${process.env.QUILT_NIGHTLY_CC_IMAGE || FALLBACK_CC_DOCKERFILE_URL}
  codex_image=${process.env.QUILT_NIGHTLY_CODEX_IMAGE || FALLBACK_CODEX_DOCKERFILE_URL}
  claude_path=${process.env.QUILT_NIGHTLY_CLAUDE_PATH || '(auto-resolve in container)'}
  codex_path=${process.env.QUILT_NIGHTLY_CODEX_PATH || '(auto-resolve in container)'}
`);
}

function parseArgs(argv) {
  const d = defaults();
  const args = {
    cc: false,
    codex: false,
    profile: null,
    apiUrl: d.apiUrl,
    image: '',
    name: null,
    token: d.token,
    toolPath: '',
    startTimeoutMs: d.startTimeoutMs,
    keep: false,
    cleanup: true,
    envFile: null,
    noEnv: false,
    cols: null,
    rows: null,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cc') args.cc = true;
    else if (a === '--codex') args.codex = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--keep') {
      args.keep = true;
      args.cleanup = false;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (args.cc && args.codex) {
    throw new Error('Choose only one profile flag: --cc or --codex');
  }
  if (args.cc) args.profile = PROFILE_CC;
  if (args.codex) args.profile = PROFILE_CODEX;

  if (args.profile) {
    args.image = process.env[args.profile.envImage] || args.profile.fallbackImage;
    args.toolPath = process.env[args.profile.envPath] || '';
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

function terminalSize() {
  const cols = Number(process.stdout.columns) || 80;
  const rows = Number(process.stdout.rows) || 24;
  return { cols, rows };
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

async function resolveToolPath(apiUrl, token, containerId, preferredPath, profile) {
  const preferred = String(preferredPath || '').trim();
  if (preferred) return preferred;

  const [firstCandidate, secondCandidate] = profile.fallbackPathCandidates;
  const command = [
    `if [ -x ${firstCandidate} ]; then echo ${firstCandidate};`,
    `elif [ -x ${secondCandidate} ]; then echo ${secondCandidate};`,
    `elif command -v ${profile.executable} >/dev/null 2>&1; then command -v ${profile.executable};`,
    'else exit 127; fi',
  ].join(' ');

  const data = await apiRequest({
    method: 'POST',
    apiUrl,
    path: `/api/containers/${encodeURIComponent(containerId)}/exec`,
    token,
    body: {
      command,
      capture_output: true,
      detach: false,
      timeout_ms: 20_000,
    },
  });

  const exitCode = Number(data?.exit_code ?? -1);
  const stdout = String(data?.stdout || '')
    .trim()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s);

  if (exitCode !== 0 || !stdout || !stdout.startsWith('/')) {
    throw new Error(`Unable to resolve ${profile.displayName} binary path via container exec`);
  }
  return stdout;
}

/**
 * @param {{
 *   apiUrl: string,
 *   token: string | null,
 *   containerId: string,
 *   cols: number,
 *   rows: number,
 *   toolPath: string
 * }} options
 */
function attachTool({ apiUrl, token, containerId, cols, rows, toolPath }) {
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
 *   profile: typeof PROFILE_CC | typeof PROFILE_CODEX,
 *   startTimeoutMs: number,
 *   cols: number | null,
 *   rows: number | null,
 *   cleanup: boolean,
 *   keep: boolean
 * }} args
 */
async function runProfileFlow(args) {
  const profile = args.profile;
  const name = args.name || randomName(profile);
  process.stderr.write(`[quilt-nightly] creating container '${name}' via API\n`);
  process.stderr.write('[quilt-nightly] preparing runtime image (this can take a little while)\n');

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
        command: ['tail', '-f', '/dev/null'],
        strict: true,
      },
    }),
    '[quilt-nightly] pulling/building image...'
  );

  const containerId = created?.container_id;
  if (!containerId) throw new Error('API did not return container_id');
  process.stderr.write(`[quilt-nightly] container id: ${containerId}\n`);

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
    process.stderr.write(
      `[quilt-nightly] container running; launching ${profile.displayName} TUI...\n`
    );
    process.stderr.write(
      `[quilt-nightly] resolving ${profile.displayName} executable path via API exec...\n`
    );
    const resolvedToolPath = await resolveToolPath(
      args.apiUrl,
      args.token,
      containerId,
      args.toolPath,
      profile
    );

    const size = terminalSize();
    const cols = Number.isFinite(args.cols) && args.cols > 0 ? args.cols : size.cols;
    const rows = Number.isFinite(args.rows) && args.rows > 0 ? args.rows : size.rows;
    process.stderr.write(
      `[quilt-nightly] opening terminal session (container=${containerId}, shell=${resolvedToolPath})\n`
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
      toolPath: resolvedToolPath,
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
