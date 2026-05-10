#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const API_URL = process.env.QUILT_API_URL || 'https://backend.quilt.sh';
const IMAGE_REF = process.env.E2E_AEGIS_IMAGE_REF || 'prod-gui';
const LOCAL_SYNC_DIR = path.resolve(process.cwd(), 'aegis');
const REMOTE_SYNC_DIR = '/workspace/aegis';
const RUN_BOOTSTRAP = process.env.E2E_AEGIS_BOOTSTRAP === '1';

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [rawKey, ...rest] = line.split('=');
    const key = rawKey.replace(/^export\s+/, '').trim();
    const value = rest.join('=').trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const API_KEY = process.env.QUILT_API_KEY || process.env.QUILT_TOKEN || '';
if (!API_KEY) {
  throw new Error('Missing QUILT_API_KEY or QUILT_TOKEN');
}

function authHeaders() {
  if (API_KEY.startsWith('quilt_sk_')) {
    return { 'X-Api-Key': API_KEY };
  }
  return { Authorization: `Bearer ${API_KEY}` };
}

async function apiRequest(method, apiPath, body) {
  const res = await fetch(`${API_URL.replace(/\/$/, '')}${apiPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${apiPath} failed (${res.status}): ${text}`);
  }
  return json;
}

async function waitForOperation(operationId, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await apiRequest('GET', `/api/operations/${encodeURIComponent(operationId)}`);
    const status = String(data?.status || '').toLowerCase();
    if (status === 'succeeded') return data;
    if (['failed', 'cancelled', 'canceled', 'timed_out'].includes(status)) {
      throw new Error(`Operation ${operationId} failed with status=${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for operation ${operationId}`);
}

async function waitForReady(containerId, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await apiRequest('GET', `/api/containers/${encodeURIComponent(containerId)}/ready`);
    if (data?.exec_ready && data?.network_ready && data?.gui_ready) return data;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for prod-gui container ${containerId} readiness`);
}

function makeArchiveBase64(localDir) {
  const tarResult = spawnSync('tar', ['-C', localDir, '-czf', '-', '.'], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (tarResult.error) throw tarResult.error;
  if (tarResult.status !== 0) {
    throw new Error(`tar failed: ${Buffer.from(tarResult.stderr || []).toString('utf8')}`);
  }
  return Buffer.from(tarResult.stdout || []).toString('base64');
}

async function execInContainer(containerId, command, workdir = '/workspace', timeoutMs = 120_000) {
  const url = `${API_URL.replace(/\/$/, '')}/api/containers/${encodeURIComponent(containerId)}/exec`;
  const payload = JSON.stringify({
    command,
    workdir,
    timeout_ms: timeoutMs,
  });
  const headerArgs = API_KEY.startsWith('quilt_sk_')
    ? ['-H', `X-Api-Key: ${API_KEY}`]
    : ['-H', `Authorization: Bearer ${API_KEY}`];
  const curlResult = spawnSync(
    'curl',
    [
      '-sS',
      '--max-time',
      String(Math.ceil(timeoutMs / 1000) + 120),
      '-X',
      'POST',
      url,
      '-H',
      'Content-Type: application/json',
      ...headerArgs,
      '--data-binary',
      payload,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  if (curlResult.error) {
    throw curlResult.error;
  }
  if (curlResult.status !== 0) {
    throw new Error(`curl exec failed: ${curlResult.stderr || curlResult.stdout || 'unknown error'}`);
  }
  try {
    return JSON.parse(curlResult.stdout || 'null');
  } catch (error) {
    throw new Error(`failed to parse exec response: ${error.message}\n${curlResult.stdout}`);
  }
}

async function deleteContainer(containerId) {
  try {
    await apiRequest('DELETE', `/api/containers/${encodeURIComponent(containerId)}`);
    return;
  } catch (error) {
    const url = `${API_URL.replace(/\/$/, '')}/api/containers/${encodeURIComponent(containerId)}`;
    const headerArgs = API_KEY.startsWith('quilt_sk_')
      ? ['-H', `X-Api-Key: ${API_KEY}`]
      : ['-H', `Authorization: Bearer ${API_KEY}`];
    const curlResult = spawnSync(
      'curl',
      ['-sS', '-X', 'DELETE', url, ...headerArgs],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      }
    );
    if (curlResult.status === 0) {
      return;
    }
    throw error;
  }
}

async function runBootstrapDoctor(containerId) {
  const marker = '__QUILT_AEGIS_EXIT__';
  const bootstrap = await execInContainer(
    containerId,
    [
      '/bin/sh',
      '-lc',
      [
        'mkdir -p /workspace/.quilt/aegis',
        'python3 /workspace/aegis/quilt_aegis.py doctor --bootstrap --json >/workspace/.quilt/aegis/bootstrap-e2e.log 2>&1',
        'code=$?',
        `echo ${marker}:$code`,
        'tail -n 200 /workspace/.quilt/aegis/bootstrap-e2e.log',
      ].join('; '),
    ],
    '/workspace',
    3_600_000
  );
  const stdout = String(bootstrap?.stdout || '');
  const match = stdout.match(new RegExp(`${marker}:(\\d+)`));
  const exitCode = match ? Number(match[1]) : null;
  if (exitCode !== 0) {
    throw new Error(`bootstrap failed: ${bootstrap?.stderr || stdout || 'unknown error'}`);
  }
  return bootstrap;
}

async function main() {
  let containerId = null;
  const name = `e2e-aegis-${Date.now().toString(36)}`;

  try {
    console.log('health');
    await apiRequest('GET', '/health');
    await apiRequest('GET', '/api/containers/health');

    console.log(`create prod-gui container ${name}`);
    const created = await apiRequest('POST', '/api/containers?execution=sync', {
      name,
      image: IMAGE_REF,
      oci: false,
      strict: true,
      working_directory: '/workspace',
    });
    containerId = created?.container_id;
    if (!containerId) {
      throw new Error('container_id missing from create response');
    }

    console.log(`wait gui-ready ${containerId}`);
    await waitForReady(containerId);

    console.log('fetch gui url');
    const gui = await apiRequest('GET', `/api/containers/${encodeURIComponent(containerId)}/gui-url`);
    if (!gui?.gui_url) {
      throw new Error('gui_url missing from prod-gui response');
    }
    console.log(`gui url ${gui.gui_url}`);

    console.log(`archive sync ${LOCAL_SYNC_DIR} -> ${REMOTE_SYNC_DIR}`);
    const syncAccepted = await apiRequest(
      'POST',
      `/api/containers/${encodeURIComponent(containerId)}/archive`,
      {
        content: makeArchiveBase64(LOCAL_SYNC_DIR),
        path: REMOTE_SYNC_DIR,
      }
    );
    if (!syncAccepted?.operation_id) {
      throw new Error('archive upload missing operation_id');
    }
    await waitForOperation(syncAccepted.operation_id);

    console.log('run helper doctor');
    const doctor = await execInContainer(
      containerId,
      ['python3', '/workspace/aegis/quilt_aegis.py', 'doctor', '--json'],
      '/workspace',
      120_000
    );
    if (doctor?.exit_code !== 0) {
      throw new Error(`doctor failed: ${doctor?.stderr || doctor?.stdout || 'unknown error'}`);
    }
    console.log(doctor.stdout || '');

    if (RUN_BOOTSTRAP) {
      console.log('bootstrap aegis inside prod-gui');
      const bootstrap = await runBootstrapDoctor(containerId);
      console.log(bootstrap.stdout || '');
    }
  } finally {
    if (containerId) {
      try {
        console.log(`delete container ${containerId}`);
        await deleteContainer(containerId);
      } catch (error) {
        console.error(`cleanup failed for ${containerId}: ${error.message}`);
      }
    }
  }
}

await main();
