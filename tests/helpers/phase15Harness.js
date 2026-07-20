'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TENANTS = Object.freeze(['admin', 'panel', 'regina', 'portugal', 'felipe', 'ana']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
}

function createFixture(dataDir) {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'create-sanitized-fixture.js'), `--output=${dataDir}`, '--force'],
    { cwd: ROOT, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function appendSyntheticLeads(dataDir, tenantId, count, options = {}) {
  const file = path.join(dataDir, tenantId, 'leads.jsonl');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
  const offset = Number(options.offset || existing.length);
  const source = options.source || 'phase15_load';
  const rows = Array.from({ length: count }, (_, index) => {
    const ordinal = offset + index + 1;
    const suffix = String(ordinal).padStart(8, '0').slice(-8);
    return {
      id: `phase15-${tenantId}-${String(ordinal).padStart(6, '0')}`,
      source,
      sourceDetail: 'Fixture sintética da Fase 15',
      sourceMeta: { synthetic: true, phase: 15 },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ordinal % 60)).toISOString(),
      nome: `Lead Sintético ${ordinal}`,
      empresa: `Empresa Sintética ${ordinal}`,
      jaAnuncia: ordinal % 2 ? 'Sim' : 'Não',
      website: 'https://example.invalid',
      email: `phase15-${tenantId}-${ordinal}@example.invalid`,
      whatsapp_raw: `55119${suffix}`,
      whatsapp_digits: `55119${suffix}`,
      tags: '',
      active_contact_id: '',
      active_seriesid: '',
    };
  });
  fs.appendFileSync(file, rows.map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
  return rows;
}

function credentialsForTenants() {
  return Object.fromEntries(TENANTS.map((tenantId) => [tenantId, {
    username: `${tenantId}_${crypto.randomBytes(5).toString('hex')}`,
    password: crypto.randomBytes(32).toString('base64url'),
  }]));
}

function buildEnv(root, port, credentials, overrides = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_BASE_URL: baseUrl,
    ZAPE_DATA_DIR: path.join(root, 'data'),
    SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
    SESSION_STORE_FILE: path.join(root, 'sessions.json'),
    SECURITY_AUDIT_FILE: path.join(root, 'audit.jsonl'),
    STRUCTURED_LOG_FILE: path.join(root, 'logs', 'application.jsonl'),
    ALERT_STATE_FILE: path.join(root, 'alerts.json'),
    BACKUP_DIRECTORY: path.join(root, 'backups'),
    BACKUP_REMOTE_DIRECTORY: path.join(root, 'remote-backups'),
    CONFIG_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    WEBHOOK_EVENT_STORE_FILE: path.join(root, 'webhook-events.json'),
    WEBJS_ENABLED: '0',
    WEBJS_AUTO_START: '0',
    CRM_INTEGRATION_ENABLED: '0',
    PUBLIC_LEAD_FORM_ENABLED: '0',
    ACTIVECAMPAIGN_WEBHOOK_ENABLED: '0',
    DATA_INTEGRITY_VALIDATE_ON_BOOT: '0',
    WA_CLOUD_ENABLED: '0',
    PERSISTENCE_MODE: 'json',
    ENABLE_DEBUG_ACTIVE: '0',
    MONITOR_INTERVAL_MS: '60000',
    ...overrides,
  };
  for (const tenantId of TENANTS) {
    const prefix = tenantId.toUpperCase();
    const enabled = credentials && credentials[tenantId];
    env[`${prefix}_ENABLED`] = enabled ? '1' : '0';
    if (enabled) {
      env[`${prefix}_USER`] = credentials[tenantId].username;
      env[`${prefix}_PASS`] = credentials[tenantId].password;
    }
  }
  return { env, baseUrl };
}

async function waitForHealth(baseUrl, child, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) return true;
    } catch (_) {}
    await sleep(100);
  }
  return false;
}

function spawnApplication(env) {
  const output = { stdout: '', stderr: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output.stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output.stderr += chunk.toString(); });
  return { child, output };
}

async function startApplication(env, baseUrl) {
  const handle = spawnApplication(env);
  const healthy = await waitForHealth(baseUrl, handle.child);
  assert.equal(healthy, true, JSON.stringify(handle.output));
  return handle;
}

async function stopApplication(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(7000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function responseCookies(response) {
  return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
}

function cookieValue(cookieHeader, name) {
  const entry = String(cookieHeader || '').split(/;\s*/).find((item) => item.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

async function login(baseUrl, tenantId, credentials) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      tenant: tenantId,
      username: credentials[tenantId].username,
      password: credentials[tenantId].password,
    }),
  });
  assert.equal(response.status, 200, await response.text());
  const cookie = responseCookies(response);
  return { cookie, csrf: cookieValue(cookie, 'zape_csrf') };
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.auth) headers.Cookie = options.auth.cookie;
  if (options.body !== undefined) headers['Content-Type'] = options.contentType || 'application/json';
  if (options.mutating) {
    headers.Origin = baseUrl;
    headers['X-Zape-CSRF-Token'] = options.auth?.csrf || '';
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined
      ? undefined
      : options.rawBody
        ? options.body
        : JSON.stringify(options.body),
    redirect: options.redirect || 'follow',
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { response, status: response.status, payload, text };
}

async function startFakeMetaServer(options = {}) {
  const port = options.port || await freePort();
  const state = { requests: [], counts: new Map(), sequence: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body = {};
    try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch {}
    state.requests.push({ method: req.method, url: req.url, body });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'POST' && /\/messages$/.test(url.pathname)) {
      const recipient = String(body.to || '');
      const count = (state.counts.get(recipient) || 0) + 1;
      state.counts.set(recipient, count);
      const behavior = options.behavior ? options.behavior(recipient, count, body) : null;
      if (behavior) {
        res.writeHead(behavior.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(behavior.body));
        return;
      }
      state.sequence += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: `wamid.phase15.${state.sequence}` }], contacts: [{ wa_id: recipient }] }));
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'synthetic', name: 'Synthetic Meta', data: [] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 100, message: 'not found' } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function makeTempRoot(prefix = 'zape-phase15-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = {
  ROOT,
  TENANTS,
  sleep,
  freePort,
  writeJson,
  writeJsonl,
  createFixture,
  appendSyntheticLeads,
  credentialsForTenants,
  buildEnv,
  spawnApplication,
  startApplication,
  stopApplication,
  login,
  jsonRequest,
  startFakeMetaServer,
  makeTempRoot,
};
