#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';

const API_URL = process.env.QUILT_API_URL || 'https://backend.quilt.sh';
const AMP_DIR = path.resolve(process.cwd(), 'amp');
const REMOTE_SYNC_DIR = '/workspace/amp';
const IMAGE_REF = `quilt.local/e2e-amp-${Date.now().toString(36)}:latest`;
const SUMMARY_ONLY = process.env.E2E_AMP_SUMMARY_ONLY === '1';

function log(message) {
  if (!SUMMARY_ONLY) {
    console.log(message);
  }
}

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

async function waitForReady(containerId, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await apiRequest('GET', `/api/containers/${encodeURIComponent(containerId)}/ready`);
    if (data?.exec_ready && data?.network_ready) return data;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for container ${containerId} readiness`);
}

async function waitForPublishedService(serviceId, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await apiRequest('GET', `/api/services/${encodeURIComponent(serviceId)}`);
    const status = String(data?.status || '').toLowerCase();
    if (status === 'ready') return data;
    if (status === 'expired' || status === 'error') {
      throw new Error(`service ${serviceId} entered terminal status ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for published service ${serviceId}`);
}

async function waitForOperation(operationId, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await apiRequest('GET', `/api/operations/${encodeURIComponent(operationId)}`);
    const status = String(data?.status || '').toLowerCase();
    if (status === 'succeeded') return data;
    if (['failed', 'cancelled', 'canceled', 'timed_out'].includes(status)) {
      throw new Error(
        `Operation ${operationId} failed with status=${status}: ${JSON.stringify(data)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for operation ${operationId}`);
}

function makeArchiveBase64(localDir) {
  const tarResult = spawnSync('tar', ['-C', localDir, '-czf', '-', '.'], {
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (tarResult.error) throw tarResult.error;
  if (tarResult.status !== 0) {
    throw new Error(`tar failed: ${Buffer.from(tarResult.stderr || []).toString('utf8')}`);
  }
  return Buffer.from(tarResult.stdout || []).toString('base64');
}

async function execInContainer(containerId, command, workdir = '/workspace', timeoutMs = 180_000) {
  return await apiRequest('POST', `/api/containers/${encodeURIComponent(containerId)}/exec`, {
    command,
    workdir,
    timeout_ms: timeoutMs,
  });
}

async function fetchJson(url) {
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`GET ${url} failed (${res.status}): ${text}`);
  }
  return json;
}

function joinLinxUrl(baseUrl, suffix) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${suffix.replace(/^\//, '')}`;
  return url.toString();
}

async function verifyWebSocket(url, agentId, token) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
      try {
        ws.close();
      } catch {
        // Ignore close errors.
      }
    };

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'connect',
          agent_id: agentId,
          token,
        })
      );
    });

    ws.on('message', (data) => {
      let message = null;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch (error) {
        finish(error);
        return;
      }
      if (message.type === 'connected') {
        ws.send(JSON.stringify({ type: 'ping' }));
        return;
      }
      if (message.type === 'pong') {
        finish();
        return;
      }
      if (message.type === 'error') {
        finish(new Error(`websocket error: ${message.message || 'unknown'}`));
      }
    });

    ws.on('error', (error) => {
      finish(error);
    });
  });
}

async function main() {
  let containerId = null;
  let serviceId = null;

  try {
    log('health');
    await apiRequest('GET', '/health');
    await apiRequest('GET', '/api/containers/health');
    await apiRequest('GET', '/api/oci/health');

    log('build amp image context');
    const uploaded = await apiRequest('POST', '/api/build-contexts', {
      content: makeArchiveBase64(AMP_DIR),
    });
    const contextId = uploaded?.context_id;
    if (!contextId) {
      throw new Error('build context missing context_id');
    }

    log(`build image ${IMAGE_REF}`);
    const built = await apiRequest('POST', '/api/oci/images/build', {
      context_id: contextId,
      image_reference: IMAGE_REF,
      dockerfile_path: 'Dockerfile',
    });
    if (!built?.operation_id) {
      throw new Error(`image build failed: ${JSON.stringify(built)}`);
    }
    await waitForOperation(built.operation_id, 900_000);

    const name = `e2e-amp-${Date.now().toString(36)}`;
    log(`create container ${name}`);
    const created = await apiRequest('POST', '/api/containers?execution=sync', {
      name,
      image: IMAGE_REF,
      oci: true,
      command: ['tail', '-f', '/dev/null'],
      strict: true,
      working_directory: '/workspace',
    });
    containerId = created?.container_id;
    if (!containerId) {
      throw new Error('container_id missing from create response');
    }

    log(`wait ready ${containerId}`);
    await waitForReady(containerId);

    log(`archive sync ${AMP_DIR} -> ${REMOTE_SYNC_DIR}`);
    const syncAccepted = await apiRequest(
      'POST',
      `/api/containers/${encodeURIComponent(containerId)}/archive`,
      {
        content: makeArchiveBase64(AMP_DIR),
        path: REMOTE_SYNC_DIR,
      }
    );
    if (!syncAccepted?.operation_id) {
      throw new Error('archive upload missing operation_id');
    }
    await waitForOperation(syncAccepted.operation_id);

    log('bootstrap amp state');
    const bootstrap = await execInContainer(
      containerId,
      ['python3', '/workspace/amp/quilt_amp.py', 'bootstrap', '--json'],
      '/workspace'
    );
    if (bootstrap?.exit_code !== 0) {
      throw new Error(`bootstrap failed: ${bootstrap?.stderr || bootstrap?.stdout || 'unknown error'}`);
    }
    const bootstrapJson = JSON.parse(String(bootstrap.stdout || '{}'));

    log('launch amp daemon');
    const launch = await execInContainer(
      containerId,
      ['python3', '/workspace/amp/quilt_amp.py', 'launch', '--addr', '0.0.0.0:7001', '--json'],
      '/workspace'
    );
    if (launch?.exit_code !== 0) {
      throw new Error(`launch failed: ${launch?.stderr || launch?.stdout || 'unknown error'}`);
    }
    log(launch.stdout || '');

    log('publish amp service');
    const service = await apiRequest(
      'POST',
      `/api/containers/${encodeURIComponent(containerId)}/services`,
      {
        name: 'amp',
        target_port: 7001,
        protocol: 'http',
        enable_websockets: true,
        auth_mode: 'service_token',
      }
    );
    serviceId = service?.service_id;
    if (!serviceId) {
      throw new Error('service create missing service_id');
    }

    const readyService = await waitForPublishedService(serviceId);
    log(`service ready ${readyService.public_url}`);

    log('check published health');
    const health = await fetchJson(joinLinxUrl(readyService.public_url, 'health'));
    if (health?.ok !== true) {
      throw new Error(`unexpected health payload: ${JSON.stringify(health)}`);
    }

    log('check published system snapshot');
    const system = await fetchJson(joinLinxUrl(readyService.public_url, 'v1/system'));
    if (String(system?.node_id || '') !== String(bootstrapJson.node_id || '')) {
      throw new Error(`unexpected system node id: ${JSON.stringify(system)}`);
    }

    log('check published websocket');
    await verifyWebSocket(
      readyService.websocket_url,
      String(bootstrapJson.bootstrap_agent || 'owner'),
      String(bootstrapJson.bootstrap_token || '')
    );
    console.log('amp ingress e2e ok');
  } finally {
    if (serviceId) {
      try {
        log(`delete service ${serviceId}`);
        await apiRequest('DELETE', `/api/services/${encodeURIComponent(serviceId)}`);
      } catch (error) {
        console.error(`service cleanup failed for ${serviceId}: ${error.message}`);
      }
    }
    if (containerId) {
      try {
        log(`delete container ${containerId}`);
        await apiRequest('DELETE', `/api/containers/${encodeURIComponent(containerId)}`);
      } catch (error) {
        console.error(`container cleanup failed for ${containerId}: ${error.message}`);
      }
    }
    try {
      log(`delete image ${IMAGE_REF}`);
      await apiRequest('DELETE', `/api/oci/images?reference=${encodeURIComponent(IMAGE_REF)}`);
    } catch (error) {
      console.error(`image cleanup failed for ${IMAGE_REF}: ${error.message}`);
    }
  }
}

await main();
