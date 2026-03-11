#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const FALLBACK_API_URL = 'https://backend.quilt.sh';
const FALLBACK_CLAUDE_PATH = '/usr/local/bin/claude';
const FALLBACK_CC_DOCKERFILE_URL =
  'https://raw.githubusercontent.com/ariacomputecompany/quilt-nightly/main/cc/Dockerfile';
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_ENV_FILES = ['.env', '.env.local'];

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
    image: process.env.QUILT_NIGHTLY_CC_IMAGE || FALLBACK_CC_DOCKERFILE_URL,
    token: process.env.QUILT_TOKEN || process.env.QUILT_API_KEY || null,
    claudePath: process.env.QUILT_NIGHTLY_CLAUDE_PATH || FALLBACK_CLAUDE_PATH,
    startTimeoutMs: Number(process.env.QUILT_NIGHTLY_START_TIMEOUT_MS) || DEFAULT_START_TIMEOUT_MS,
  };
}

function usage(d) {
  console.log(`quilt-nightly

Usage:
  npx quilt-nightly --cc [options]

Options:
  --cc                     Launch a Claude Code container flow via API
  --name <name>            Container name (default: auto-generated)
  --keep                   Keep container after terminal exits
  --help                   Show this help

Automatic defaults (no flags needed):
  api_url=${d.apiUrl}
  image=${d.image || '(empty -> server auto Dockerfile lookup)'}
  claude_path=${d.claudePath}
`);
}

function parseArgs(argv) {
  const d = defaults();
  const args = {
    cc: false,
    apiUrl: d.apiUrl,
    image: d.image,
    name: null,
    token: d.token,
    claudePath: d.claudePath,
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
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--keep') {
      args.keep = true;
      args.cleanup = false;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  return args;
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
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const msg = json?.error || json?.message || JSON.stringify(json) || text;
    throw new Error(`${method} ${apiPath} failed (${res.status}): ${msg}`);
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
    process.stderr.write(`\n[quilt-nightly] cleanup failed for ${containerId}: ${e.message}\n`);
  }
}

function attachClaude({ apiUrl, token, containerId, cols, rows, claudePath }) {
  return new Promise((resolve, reject) => {
    const wsBase = toWsBase(apiUrl).replace(/\/$/, '');
    const params = new URLSearchParams({
      container_id: containerId,
      cols: String(cols),
      rows: String(rows),
      shell: claudePath,
    });
    if (token) params.set('token', token);

    const wsUrl = `${wsBase}/ws/terminal/attach?${params.toString()}`;
    const ws = new WebSocket(wsUrl, 'terminal');

    let settled = false;
    let rawEnabled = false;
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
    };

    ws.on('open', () => {
      if (stdin.isTTY) {
        stdin.setRawMode(true);
        rawEnabled = true;
      }
      stdin.resume();
      stdin.on('data', onData);
      process.stdout.on('resize', onResize);
      onResize();
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        process.stdout.write(data);
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
      } else if (msg.type === 'exit') {
        cleanupIO();
        settled = true;
        ws.close();
        resolve(msg.code ?? 0);
      }
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

function randomName() {
  return `nightly-cc-${Date.now().toString(36)}`;
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

  if (!args.claudePath || !args.claudePath.trim()) {
    throw new Error('--claude-path must be non-empty');
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

async function runCcFlow(args) {
  const name = args.name || randomName();
  process.stderr.write(`[quilt-nightly] creating container '${name}' via API\n`);

  const created = await apiRequest({
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
  });

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
    process.stderr.write('[quilt-nightly] container running; launching Claude TUI...\n');

    const size = terminalSize();
    const cols = Number.isFinite(args.cols) && args.cols > 0 ? args.cols : size.cols;
    const rows = Number.isFinite(args.rows) && args.rows > 0 ? args.rows : size.rows;

    const exitCode = await attachClaude({
      apiUrl: args.apiUrl,
      token: args.token,
      containerId,
      cols,
      rows,
      claudePath: args.claudePath,
    });

    await maybeCleanup();
    process.exitCode = typeof exitCode === 'number' ? exitCode : 0;
  } finally {
    process.off('SIGINT', sigHandler);
    process.off('SIGTERM', sigHandler);
  }
}

async function main() {
  try {
    loadLocalEnv(process.argv);
    const args = parseArgs(process.argv);

    if (args.help || !args.cc) {
      usage(defaults());
      process.exit(args.help ? 0 : 1);
    }

    validateArgs(args);
    await runCcFlow(args);
  } catch (err) {
    process.stderr.write(`[quilt-nightly] error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
