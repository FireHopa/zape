'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const express = require('express');

const { TENANT_CONFIGS, validateAuthConfiguration } = require('../src/authConfig');
const {
  makeBasicAuth,
  anyTenantAuth,
  registerAuthRoutes,
  checkCredentials,
  __test,
} = require('../src/basicAuthFactory');

const AUTH_ENV_NAMES = [
  'NODE_ENV', 'SESSION_SECRET', 'AUTH_SECRET', 'SESSION_STORE_FILE', 'ZAPE_DATA_DIR',
  'AUTH_RATE_LIMIT_WINDOW_MS', 'AUTH_RATE_LIMIT_BLOCK_MS',
  'AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS', 'AUTH_RATE_LIMIT_TENANT_IP_MAX_ATTEMPTS',
  'AUTH_RATE_LIMIT_TENANT_MAX_ATTEMPTS', 'AUTH_TRUST_PROXY_HEADERS',
  ...Object.values(TENANT_CONFIGS).flatMap((cfg) => [cfg.enabledEnv, cfg.userEnv, cfg.passEnv, cfg.roleEnv]),
];

function snapshotEnv() {
  return Object.fromEntries(AUTH_ENV_NAMES.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot) {
  for (const name of AUTH_ENV_NAMES) {
    if (snapshot[name] === undefined) delete process.env[name];
    else process.env[name] = snapshot[name];
  }
}

function configureAllTenants(root, overrides = {}) {
  process.env.NODE_ENV = overrides.NODE_ENV || 'test';
  process.env.SESSION_SECRET = overrides.SESSION_SECRET || crypto.randomBytes(48).toString('base64url');
  delete process.env.AUTH_SECRET;
  process.env.SESSION_STORE_FILE = path.join(root, 'auth_sessions.json');
  process.env.AUTH_RATE_LIMIT_WINDOW_MS = overrides.AUTH_RATE_LIMIT_WINDOW_MS || '60000';
  process.env.AUTH_RATE_LIMIT_BLOCK_MS = overrides.AUTH_RATE_LIMIT_BLOCK_MS || '60000';
  process.env.AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS = overrides.AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS || '100';
  process.env.AUTH_RATE_LIMIT_TENANT_IP_MAX_ATTEMPTS = overrides.AUTH_RATE_LIMIT_TENANT_IP_MAX_ATTEMPTS || '100';
  process.env.AUTH_RATE_LIMIT_TENANT_MAX_ATTEMPTS = overrides.AUTH_RATE_LIMIT_TENANT_MAX_ATTEMPTS || '1000';
  process.env.AUTH_TRUST_PROXY_HEADERS = '0';

  for (const cfg of Object.values(TENANT_CONFIGS)) {
    process.env[cfg.enabledEnv] = '1';
    process.env[cfg.userEnv] = `${cfg.tenantId}_user`;
    process.env[cfg.passEnv] = crypto.randomBytes(24).toString('base64url');
  }
}

async function createTestServer() {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  for (const cfg of Object.values(TENANT_CONFIGS)) {
    app.get(`/protected/${cfg.tenantId}`, makeBasicAuth(cfg), (req, res) => {
      res.json({ ok: true, auth: req.auth });
    });
  }
  app.get('/protected-any', anyTenantAuth, (req, res) => res.json({ ok: true, auth: req.auth }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function cookieFrom(response, tenantId) {
  const header = response.headers.get('set-cookie') || '';
  const match = header.match(new RegExp(`(?:^|,\\s*)(${__test.cookieName(tenantId)}=[^;]+)`));
  assert.ok(match, `cookie de ${tenantId} não encontrado em ${header}`);
  return match[1];
}

async function login(baseUrl, tenantId, username, password, remember = true) {
  return fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: tenantId, username, password, remember }),
  });
}

function serial(name, fn) {
  test(name, { concurrency: false }, async (t) => {
    const previous = snapshotEnv();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-auth-'));
    __test.loginRateLimiter.reset();
    try { await fn(t, root); }
    finally {
      __test.loginRateLimiter.reset();
      restoreEnv(previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

serial('configuração incompleta falha de forma fechada', async (_t, root) => {
  configureAllTenants(root);
  delete process.env.ADMIN_PASS;
  const result = validateAuthConfiguration({ mode: 'production' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /admin habilitado sem o par completo/i);
  assert.equal(checkCredentials('admin', 'admin_user', crypto.randomBytes(16).toString('base64url')).ok, false);
});

serial('SESSION_SECRET ausente ou previsível é rejeitado', async (_t, root) => {
  configureAllTenants(root);
  delete process.env.SESSION_SECRET;
  let result = validateAuthConfiguration({ mode: 'production' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /SESSION_SECRET é obrigatório/i);
  assert.throws(() => __test.getSecret(), /ausente ou inseguro/i);

  process.env.SESSION_SECRET = String.fromCharCode(97).repeat(48);
  result = validateAuthConfiguration({ mode: 'production' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /baixa diversidade/i);
});

serial('tenant desabilitado não libera rota por ausência de credenciais', async (_t, root) => {
  configureAllTenants(root);
  process.env.ADMIN_ENABLED = '0';
  delete process.env.ADMIN_USER;
  delete process.env.ADMIN_PASS;
  const server = await createTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/protected/admin`, { headers: { Accept: 'application/json' } });
    assert.equal(response.status, 403);
  } finally { await server.close(); }
});

serial('todos os tenants autenticam somente com suas credenciais explícitas', async (_t, root) => {
  configureAllTenants(root);
  const server = await createTestServer();
  try {
    for (const cfg of Object.values(TENANT_CONFIGS)) {
      const response = await login(
        server.baseUrl,
        cfg.tenantId,
        process.env[cfg.userEnv],
        process.env[cfg.passEnv]
      );
      assert.equal(response.status, 200, cfg.tenantId);
      const cookie = cookieFrom(response, cfg.tenantId);
      const protectedResponse = await fetch(`${server.baseUrl}/protected/${cfg.tenantId}`, {
        headers: { Cookie: cookie, Accept: 'application/json' },
      });
      assert.equal(protectedResponse.status, 200, cfg.tenantId);
      const body = await protectedResponse.json();
      assert.equal(body.auth.tenantId, cfg.tenantId);
      assert.equal(body.auth.userId, `${cfg.tenantId}:${process.env[cfg.userEnv]}`);
      assert.equal(body.auth.username, process.env[cfg.userEnv]);
      assert.equal(body.auth.role, cfg.tenantId === 'admin' ? 'super_admin' : 'tenant_admin');
      assert.ok(Array.isArray(body.auth.permissions));
      assert.equal(body.auth.method, 'cookie');
    }
  } finally { await server.close(); }
});

serial('cookie do panel não acessa rota do admin', async (_t, root) => {
  configureAllTenants(root);
  const server = await createTestServer();
  try {
    const response = await login(server.baseUrl, 'panel', process.env.PANEL_USER, process.env.PANEL_PASS);
    const cookie = cookieFrom(response, 'panel');
    const own = await fetch(`${server.baseUrl}/protected/panel`, { headers: { Cookie: cookie, Accept: 'application/json' } });
    const crossed = await fetch(`${server.baseUrl}/protected/admin`, { headers: { Cookie: cookie, Accept: 'application/json' } });
    assert.equal(own.status, 200);
    assert.equal(crossed.status, 401);
  } finally { await server.close(); }
});

serial('cookie inválido e cookie expirado são rejeitados', async (_t, root) => {
  configureAllTenants(root);
  const server = await createTestServer();
  try {
    const invalid = await fetch(`${server.baseUrl}/protected/admin`, {
      headers: { Cookie: `${__test.cookieName('admin')}=payload.assinatura-invalida`, Accept: 'application/json' },
    });
    assert.equal(invalid.status, 401);

    const expiredToken = __test.createToken({
      tenantId: 'admin',
      username: process.env.ADMIN_USER,
      ttlMs: 1000,
      now: Date.now() - 5000,
    });
    const expired = await fetch(`${server.baseUrl}/protected/admin`, {
      headers: { Cookie: `${__test.cookieName('admin')}=${encodeURIComponent(expiredToken)}`, Accept: 'application/json' },
    });
    assert.equal(expired.status, 401);
  } finally { await server.close(); }
});

serial('logout revoga a sessão no servidor e impede replay do cookie', async (_t, root) => {
  configureAllTenants(root);
  const server = await createTestServer();
  try {
    const response = await login(server.baseUrl, 'admin', process.env.ADMIN_USER, process.env.ADMIN_PASS);
    const cookie = cookieFrom(response, 'admin');
    const before = await fetch(`${server.baseUrl}/protected/admin`, { headers: { Cookie: cookie, Accept: 'application/json' } });
    assert.equal(before.status, 200);

    const logout = await fetch(`${server.baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ tenant: 'admin' }),
    });
    assert.equal(logout.status, 200);

    const replay = await fetch(`${server.baseUrl}/protected/admin`, { headers: { Cookie: cookie, Accept: 'application/json' } });
    assert.equal(replay.status, 401);
    const disk = JSON.parse(fs.readFileSync(process.env.SESSION_STORE_FILE, 'utf8'));
    assert.equal(disk.sessions.some((session) => Boolean(session.revokedAt)), true);
  } finally { await server.close(); }
});

serial('sessão persistente armazena apenas hash do identificador', async (_t, root) => {
  configureAllTenants(root);
  const token = __test.createToken({ tenantId: 'admin', username: process.env.ADMIN_USER });
  const payload = __test.verifySignedToken(token);
  const disk = fs.readFileSync(process.env.SESSION_STORE_FILE, 'utf8');
  assert.equal(disk.includes(payload.sid), false);
  assert.equal(disk.includes(token), false);
  assert.equal(disk.includes(crypto.createHash('sha256').update(payload.sid).digest('hex')), true);
});

serial('tentativas repetidas de login são bloqueadas temporariamente', async (_t, root) => {
  configureAllTenants(root, {
    AUTH_RATE_LIMIT_TENANT_IP_MAX_ATTEMPTS: '2',
    AUTH_RATE_LIMIT_BLOCK_MS: '60000',
  });
  const server = await createTestServer();
  try {
    const invalidCredential = crypto.randomBytes(24).toString('base64url');
    const first = await login(server.baseUrl, 'admin', process.env.ADMIN_USER, invalidCredential);
    const second = await login(server.baseUrl, 'admin', process.env.ADMIN_USER, invalidCredential);
    const validWhileBlocked = await login(server.baseUrl, 'admin', process.env.ADMIN_USER, process.env.ADMIN_PASS);
    assert.equal(first.status, 401);
    assert.equal(second.status, 429);
    assert.equal(validWhileBlocked.status, 429);
    assert.ok(Number(validWhileBlocked.headers.get('retry-after')) >= 1);
  } finally { await server.close(); }
});

serial('Basic Auth válido cria sessão e inválido não libera acesso', async (_t, root) => {
  configureAllTenants(root);
  const server = await createTestServer();
  try {
    const invalidCredential = crypto.randomBytes(24).toString('base64url');
    const badHeader = Buffer.from(`${process.env.ADMIN_USER}:${invalidCredential}`).toString('base64');
    const bad = await fetch(`${server.baseUrl}/protected/admin`, {
      headers: { Authorization: `Basic ${badHeader}`, Accept: 'application/json' },
    });
    assert.equal(bad.status, 401);

    const goodHeader = Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASS}`).toString('base64');
    const good = await fetch(`${server.baseUrl}/protected/admin`, {
      headers: { Authorization: `Basic ${goodHeader}`, Accept: 'application/json' },
    });
    assert.equal(good.status, 200);
    assert.match(good.headers.get('set-cookie') || '', /HttpOnly/);
  } finally { await server.close(); }
});

serial('cookie recebe Secure obrigatoriamente em produção', async (_t, root) => {
  configureAllTenants(root, { NODE_ENV: 'production' });
  const server = await createTestServer();
  try {
    const response = await login(server.baseUrl, 'admin', process.env.ADMIN_USER, process.env.ADMIN_PASS);
    assert.equal(response.status, 200);
    const header = response.headers.get('set-cookie') || '';
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Secure/);
    assert.match(header, /Path=\//);
  } finally { await server.close(); }
});

serial('boot de produção aborta com tenant habilitado e credencial incompleta', async (_t, root) => {
  const env = { ...process.env };
  for (const cfg of Object.values(TENANT_CONFIGS)) {
    env[cfg.enabledEnv] = '0';
    delete env[cfg.userEnv];
    delete env[cfg.passEnv];
  }
  env.NODE_ENV = 'production';
  env.ADMIN_ENABLED = '1';
  env.ADMIN_USER = 'admin_user';
  delete env.ADMIN_PASS;
  env.SESSION_SECRET = crypto.randomBytes(48).toString('base64url');
  env.ZAPE_DATA_DIR = root;
  env.WEBJS_ENABLED = '0';
  env.CRM_INTEGRATION_ENABLED = '0';
  env.WA_CLOUD_ENABLED = '0';

  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /AUTH_CONFIGURATION_INVALID/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /admin_password|SESSION_SECRET=/);
});
