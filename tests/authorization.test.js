'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const express = require('express');

const { TENANT_CONFIGS, validateAuthConfiguration } = require('../src/authConfig');
const { makeBasicAuth, anyTenantAuth, registerAuthRoutes, __test: authTest } = require('../src/basicAuthFactory');
const {
  ROLES,
  PERMISSIONS,
  resolveRoleForTenant,
  permissionsForRole,
  buildAuthContext,
  hasPermission,
  requireRole,
  requirePermission,
  requireTenant,
  permissionForTenantRequest,
} = require('../src/authorization');
const { recordSecurityAudit } = require('../src/securityAuditStore');

const ENV_NAMES = [
  'NODE_ENV', 'SESSION_SECRET', 'SESSION_STORE_FILE', 'SECURITY_AUDIT_FILE',
  'AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS', 'AUTH_RATE_LIMIT_TENANT_IP_MAX_ATTEMPTS',
  'AUTH_RATE_LIMIT_TENANT_MAX_ATTEMPTS', 'AUTH_TRUST_PROXY_HEADERS',
  ...Object.values(TENANT_CONFIGS).flatMap((cfg) => [cfg.enabledEnv, cfg.userEnv, cfg.passEnv, cfg.roleEnv]),
];

function snapshotEnv() {
  return Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
}

function restoreEnv(previous) {
  for (const name of ENV_NAMES) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
}

function configure(root) {
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = crypto.randomBytes(48).toString('base64url');
  process.env.SESSION_STORE_FILE = path.join(root, 'auth_sessions.json');
  process.env.SECURITY_AUDIT_FILE = path.join(root, 'security_audit.jsonl');
  process.env.AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS = '100';
  process.env.AUTH_RATE_LIMIT_TENANT_IP_MAX_ATTEMPTS = '100';
  process.env.AUTH_RATE_LIMIT_TENANT_MAX_ATTEMPTS = '1000';
  process.env.AUTH_TRUST_PROXY_HEADERS = '0';
  for (const cfg of Object.values(TENANT_CONFIGS)) {
    process.env[cfg.enabledEnv] = '1';
    process.env[cfg.userEnv] = `${cfg.tenantId}_user`;
    process.env[cfg.passEnv] = crypto.randomBytes(24).toString('base64url');
    delete process.env[cfg.roleEnv];
  }
}

function serial(name, fn) {
  test(name, { concurrency: false }, async () => {
    const previous = snapshotEnv();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-rbac-'));
    authTest.loginRateLimiter.reset();
    try {
      configure(root);
      await fn(root);
    } finally {
      authTest.loginRateLimiter.reset();
      restoreEnv(previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

async function startApp(build) {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  build(app);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function login(baseUrl, tenantId) {
  const cfg = TENANT_CONFIGS[tenantId];
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: tenantId, username: process.env[cfg.userEnv], password: process.env[cfg.passEnv] }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return cookie;
}

function fakeResponse() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

serial('roles padrão e permissões são explícitos', async () => {
  assert.equal(resolveRoleForTenant('admin'), ROLES.SUPER_ADMIN);
  assert.equal(resolveRoleForTenant('panel'), ROLES.TENANT_ADMIN);
  assert.deepEqual(permissionsForRole(ROLES.SUPER_ADMIN), [PERMISSIONS.ALL]);
  assert.equal(permissionsForRole(ROLES.VIEWER).includes(PERMISSIONS.LEADS_DELETE), false);
  assert.equal(permissionsForRole(ROLES.OPERATOR).includes(PERMISSIONS.CLOUD_CAMPAIGNS_SEND), true);
});

serial('super_admin é reservado ao tenant admin e role inválida bloqueia o boot', async () => {
  process.env.PANEL_ROLE = ROLES.SUPER_ADMIN;
  let result = validateAuthConfiguration({ mode: 'production' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /role não permitida|super_admin/i);

  process.env.PANEL_ROLE = 'root';
  result = validateAuthConfiguration({ mode: 'production' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /role inválida/i);
});

serial('contexto autenticado contém userId tenant role e permissions', async () => {
  process.env.PANEL_ROLE = ROLES.OPERATOR;
  const auth = buildAuthContext({ tenantId: 'panel', username: 'operator_test', sessionId: 'hash', method: 'cookie' });
  assert.equal(auth.userId, 'panel:operator_test');
  assert.equal(auth.tenantId, 'panel');
  assert.equal(auth.role, ROLES.OPERATOR);
  assert.equal(hasPermission(auth, PERMISSIONS.LEADS_CREATE), true);
  assert.equal(hasPermission(auth, PERMISSIONS.LEADS_DELETE), false);
});

serial('middlewares negam role permissão e tenant incorretos com 403', async () => {
  const req = { auth: buildAuthContext({ tenantId: 'panel', username: 'viewer', method: 'test' }) };
  process.env.PANEL_ROLE = ROLES.VIEWER;
  req.auth = buildAuthContext({ tenantId: 'panel', username: 'viewer', method: 'test' });

  for (const middleware of [
    requireRole(ROLES.SUPER_ADMIN),
    requirePermission(PERMISSIONS.LEADS_DELETE),
    requireTenant('admin'),
  ]) {
    const res = fakeResponse();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  }
});

serial('política de rotas tenant é fail-closed e diferencia leitura de escrita', async () => {
  const req = (method, pathname) => ({ method, path: pathname });
  assert.equal(permissionForTenantRequest(req('GET', '/api/panel/leads'), 'panel'), PERMISSIONS.LEADS_READ);
  assert.equal(permissionForTenantRequest(req('PUT', '/api/panel/leads/abc'), 'panel'), PERMISSIONS.LEADS_EDIT);
  assert.equal(permissionForTenantRequest(req('POST', '/api/panel/leads/abc/merge'), 'panel'), PERMISSIONS.LEADS_EDIT);
  assert.equal(permissionForTenantRequest(req('DELETE', '/api/panel/leads/abc'), 'panel'), PERMISSIONS.LEADS_DELETE);
  assert.equal(permissionForTenantRequest(req('POST', '/api/panel/conversations/5511999999999/messages'), 'panel'), PERMISSIONS.WHATSAPP_SEND);
  assert.equal(permissionForTenantRequest(req('GET', '/api/panel/conversations/5511999999999/media/file.ogg'), 'panel'), PERMISSIONS.WHATSAPP_READ);
  assert.equal(permissionForTenantRequest(req('POST', '/api/panel/rota-nova-sem-politica'), 'panel'), undefined);
});

serial('viewer lê o próprio tenant, mas não exclui nem altera configuração', async () => {
  process.env.PANEL_ROLE = ROLES.VIEWER;
  const panelAuth = makeBasicAuth(TENANT_CONFIGS.panel);
  const app = await startApp((server) => {
    server.get('/api/panel/leads', panelAuth, (req, res) => res.json({ ok: true, auth: req.auth }));
    server.delete('/api/panel/leads/:id', panelAuth, (_req, res) => res.json({ ok: true }));
    server.post('/api/panel/rota-nova-sem-politica', panelAuth, (_req, res) => res.json({ ok: true }));
  });
  try {
    const cookie = await login(app.baseUrl, 'panel');
    const read = await fetch(`${app.baseUrl}/api/panel/leads`, { headers: { Cookie: cookie } });
    assert.equal(read.status, 200);
    const readBody = await read.json();
    assert.equal(readBody.auth.role, ROLES.VIEWER);

    const remove = await fetch(`${app.baseUrl}/api/panel/leads/lead-1`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(remove.status, 403);
    assert.equal((await remove.json()).code, 'PERMISSION_FORBIDDEN');

    const unknown = await fetch(`${app.baseUrl}/api/panel/rota-nova-sem-politica`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(unknown.status, 403);
    assert.equal((await unknown.json()).code, 'ROUTE_POLICY_MISSING');
  } finally { await app.close(); }
});

serial('panel não acessa conexão global da Cloud e admin acessa', async () => {
  const app = await startApp((server) => {
    server.get('/api/wa-cloud/status', anyTenantAuth, requireRole(ROLES.SUPER_ADMIN), requirePermission(PERMISSIONS.CLOUD_CONNECTION_VIEW), (req, res) => res.json({ ok: true, tenantId: req.auth.tenantId }));
    server.delete('/api/wa-cloud/embedded', anyTenantAuth, requireRole(ROLES.SUPER_ADMIN), requirePermission(PERMISSIONS.CLOUD_CONNECTION_MANAGE), (req, res) => res.json({ ok: true, tenantId: req.auth.tenantId }));
    server.get('/api/wa-cloud/statuses', anyTenantAuth, requirePermission(PERMISSIONS.CLOUD_STATUSES_READ), (req, res) => res.json({ ok: true, tenantId: req.auth.tenantId, requestedTenant: req.query.tenant || null }));
  });
  try {
    const panelCookie = await login(app.baseUrl, 'panel');
    const adminCookie = await login(app.baseUrl, 'admin');

    const panelStatus = await fetch(`${app.baseUrl}/api/wa-cloud/status`, { headers: { Cookie: panelCookie } });
    assert.equal(panelStatus.status, 403);
    const panelDisconnect = await fetch(`${app.baseUrl}/api/wa-cloud/embedded`, { method: 'DELETE', headers: { Cookie: panelCookie } });
    assert.equal(panelDisconnect.status, 403);

    const panelOwnStatuses = await fetch(`${app.baseUrl}/api/wa-cloud/statuses?tenant=admin`, { headers: { Cookie: panelCookie } });
    assert.equal(panelOwnStatuses.status, 200);
    assert.equal((await panelOwnStatuses.json()).tenantId, 'panel');

    const adminStatus = await fetch(`${app.baseUrl}/api/wa-cloud/status`, { headers: { Cookie: adminCookie } });
    assert.equal(adminStatus.status, 200);
    assert.equal((await adminStatus.json()).tenantId, 'admin');
  } finally { await app.close(); }
});

serial('auditoria administrativa não persiste usuário em texto puro', async (root) => {
  const req = {
    method: 'DELETE',
    path: '/api/wa-cloud/embedded',
    auth: buildAuthContext({ tenantId: 'admin', username: 'sensitive-admin-name', method: 'test' }),
  };
  const entry = recordSecurityAudit({ req, action: 'cloud_connection.disconnect', resource: 'wa_cloud_connection' });
  assert.equal(entry.actorTenantId, 'admin');
  assert.equal(entry.actorRole, ROLES.SUPER_ADMIN);
  assert.equal(entry.actorHash.length, 64);
  const disk = fs.readFileSync(path.join(root, 'security_audit.jsonl'), 'utf8');
  assert.equal(disk.includes('sensitive-admin-name'), false);
  assert.match(disk, /cloud_connection\.disconnect/);
});
