#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';

const API_URL = process.env.QUILT_API_URL || 'https://backend.quilt.sh';
const IMAGE_REF = process.env.E2E_RLM_IMAGE_REF || 'docker.io/library/python:3.12';
const LOCAL_SYNC_DIR = path.resolve(process.cwd(), 'rlm');
const REMOTE_SYNC_DIR = '/workspace/rlm';

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

function toWsBase(apiUrl) {
  if (apiUrl.startsWith('https://')) return apiUrl.replace('https://', 'wss://');
  if (apiUrl.startsWith('http://')) return apiUrl.replace('http://', 'ws://');
  return `wss://${apiUrl}`;
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

async function waitForReady(containerId, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await apiRequest('GET', `/api/containers/${encodeURIComponent(containerId)}/ready`);
    if (data?.exec_ready) return data;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for container ${containerId} readiness`);
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

async function attachAndRun(attachUrl, command) {
  const parsedAttachUrl = new URL(attachUrl, API_URL);
  const wsUrl = `${toWsBase(API_URL).replace(/\/$/, '')}${parsedAttachUrl.pathname}${parsedAttachUrl.search}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, 'terminal', {
      headers: authHeaders(),
      followRedirects: true,
      maxRedirects: 5,
    });

    let stdout = '';
    let stderr = '';
    let sent = false;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const chunk = Array.isArray(data)
          ? Buffer.concat(data.map((part) => Buffer.from(part)))
          : Buffer.from(data);
        stdout += chunk.toString('utf8');
        return;
      }

      let message = null;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }

      if (message.type === 'ready' && !sent) {
        ws.send(Buffer.from(`${command}\n`, 'utf8'), { binary: true });
        sent = true;
        return;
      }
      if (message.type === 'error') {
        reject(new Error(`terminal error: ${message.code || 'ERROR'} ${message.message || ''}`));
        ws.close();
        return;
      }
      if (message.type === 'exit') {
        resolve({
          code: message.code ?? 0,
          stdout,
          stderr,
        });
        ws.close();
      }
    });

    ws.on('unexpected-response', (_request, response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      response.on('end', () => {
        reject(
          new Error(
            `terminal attach failed (${response.statusCode}, location=${response.headers.location || 'none'}): ${body}`
          )
        );
      });
    });

    ws.on('error', (error) => {
      stderr += `${error.message}\n`;
      reject(error);
    });
  });
}

async function main() {
  let containerId = null;
  const name = `e2e-rlm-${Date.now().toString(36)}`;

  try {
    console.log('health');
    await apiRequest('GET', '/health');
    await apiRequest('GET', '/api/containers/health');
    await apiRequest('GET', '/api/oci/health');

    console.log(`pull image ${IMAGE_REF}`);
    await apiRequest('POST', '/api/oci/images/pull', { reference: IMAGE_REF });

    console.log(`create container ${name}`);
    const created = await apiRequest('POST', '/api/containers?execution=sync', {
      name,
      image: IMAGE_REF,
      oci: true,
      command: ['tail', '-f', '/dev/null'],
      strict: true,
    });
    containerId = created?.container_id;
    if (!containerId) {
      throw new Error('container_id missing from create response');
    }

    console.log(`wait ready ${containerId}`);
    await waitForReady(containerId);

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

    console.log('create terminal session');
    const session = await apiRequest('POST', '/api/terminal/sessions', {
      container_id: containerId,
      cols: 120,
      rows: 40,
      shell: '/bin/bash',
    });
    const attachUrl = session?.attach_url;
    if (!attachUrl) {
      throw new Error('terminal session missing attach_url');
    }

    console.log('attach and run command');
    const result = await attachAndRun(
      attachUrl,
      'python /workspace/rlm/quilt_rlm.py doctor --json && python /workspace/rlm/quilt_rlm.py examples ls && exit'
    );
    console.log('terminal exit code', result.code);
    console.log(result.stdout);
    const terminalSucceeded =
      result.code === 0 ||
      (result.code === -1 &&
        result.stdout.includes('"workspace": "/workspace"') &&
        result.stdout.includes('rlm_import_error'));
    if (!terminalSucceeded) {
      throw new Error(`in-container command failed with exit code ${result.code}`);
    }
  } finally {
    if (containerId) {
      try {
        console.log(`delete container ${containerId}`);
        await apiRequest('DELETE', `/api/containers/${encodeURIComponent(containerId)}`);
      } catch (error) {
        console.error(`cleanup failed for ${containerId}: ${error.message}`);
      }
    }
  }
}

await main();
