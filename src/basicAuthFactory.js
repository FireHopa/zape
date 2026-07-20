'use strict';

const auth = require('basic-auth');
const crypto = require('crypto');
const { maskIdentifier, safeError } = require('./safeLog');
const {
  clean,
  getTenantConfig,
  isTenantEnabled,
  listTenantConfigs,
  validateSessionSecret,
} = require('./authConfig');
const sessionStore = require('./sessionStore');
const { LoginRateLimiter } = require('./loginRateLimiter');
const { buildAuthContext, enforceTenantRequest } = require('./authorization');
const { setCsrfCookie, clearCsrfCookie } = require('./csrfProtection');
const { recordSecurityAudit } = require('./securityAuditStore');
const {
  getDynamicTenant,
  verifyDynamicTenantCredentials,
  isDynamicTenantSessionUserActive,
} = require('./tenantRegistry');

const loginRateLimiter = new LoginRateLimiter();

function auditAuth(req, action, tenantId, outcome, details = {}) {
  try {
    return recordSecurityAudit({ req, action, resource: 'authentication', targetTenantId: tenantId, outcome, details });
  } catch { return null; }
}

function tenantFromEnv(userEnv) {
  return String(userEnv || '').replace(/_USER$/i, '').toLowerCase();
}

function getSecret() {
  const configured = clean(process.env.SESSION_SECRET);
  const validation = validateSessionSecret(configured, []);
  if (validation.errors.length) {
    const error = new Error('SESSION_SECRET ausente ou inseguro.');
    error.code = 'SESSION_SECRET_INVALID';
    throw error;
  }
  return configured;
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (!key) return;
    try { out[key] = decodeURIComponent(val); }
    catch { out[key] = val; }
  });
  return out;
}

function cookieName(tenantId) {
  return `zape_auth_${String(tenantId || '').toLowerCase()}`;
}

function sign(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  const max = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(max);
  const paddedB = Buffer.alloc(max);
  a.copy(paddedA);
  b.copy(paddedB);
  return crypto.timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

function encodeTokenPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function createToken({ tenantId, username, remember = true, ttlMs, now = Date.now() }) {
  const configuredTtl = Number(ttlMs);
  const defaultTtl = remember ? 30 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
  const duration = Number.isFinite(configuredTtl)
    ? Math.max(1000, Math.min(configuredTtl, 90 * 24 * 60 * 60 * 1000))
    : defaultTtl;
  const exp = now + duration;
  const { sessionId } = sessionStore.createSession({ tenantId, username, expiresAt: exp, now });
  const encoded = encodeTokenPayload({
    v: 1,
    tenantId,
    username,
    sid: sessionId,
    iat: now,
    exp,
  });
  return `${encoded}.${sign(encoded)}`;
}

function verifySignedToken(token) {
  if (!token || !String(token).includes('.')) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  let expected;
  try { expected = sign(encoded); }
  catch { return null; }

  try {
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || payload.v !== 1 || !payload.sid || !payload.tenantId || !payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function readTokenValue(token, tenantId, now = Date.now()) {
  const payload = verifySignedToken(token);
  if (!payload || payload.tenantId !== tenantId || Number(payload.exp) <= now) return null;

  let stored;
  try { stored = sessionStore.getSession(payload.sid, now); }
  catch (error) {
    console.error('[SECURITY] Falha ao consultar sessão:', safeError(error));
    return null;
  }

  if (!stored) return null;
  if (stored.tenantId !== payload.tenantId || stored.username !== payload.username) return null;
  if (Number(stored.expiresAt) !== Number(payload.exp)) return null;
  return { ...payload, sessionHash: stored.idHash };
}

function readToken(req, tenantId, now = Date.now()) {
  const token = parseCookies(req)[cookieName(tenantId)];
  return readTokenValue(token, tenantId, now);
}

function isSecureRequest(req) {
  if (clean(process.env.NODE_ENV).toLowerCase() === 'production') return true;
  const xfProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  return Boolean(req.secure || xfProto === 'https');
}

function setAuthCookie(res, req, tenantId, token, { remember = true, ttlMs } = {}) {
  const attrs = [
    `${cookieName(tenantId)}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Priority=High',
  ];
  if (remember) {
    const seconds = Math.max(1, Math.floor((Number(ttlMs) || 30 * 24 * 60 * 60 * 1000) / 1000));
    attrs.push(`Max-Age=${seconds}`);
  }
  if (isSecureRequest(req)) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearAuthCookie(res, req, tenantId) {
  const attrs = [
    `${cookieName(tenantId)}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Priority=High',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (isSecureRequest(req)) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function revokeTokenFromRequest(req, tenantId) {
  const token = parseCookies(req)[cookieName(tenantId)];
  const payload = verifySignedToken(token);
  if (!payload || payload.tenantId !== tenantId || !payload.sid) return false;
  try { return sessionStore.revokeSession(payload.sid); }
  catch (error) {
    console.error('[SECURITY] Falha ao revogar sessão:', safeError(error));
    return false;
  }
}

function wantsHtml(req) {
  const accept = String(req.get('accept') || '');
  return req.method === 'GET' && accept.includes('text/html') && !req.originalUrl.startsWith('/api/');
}

function normalizeAuthValue(value) {
  return clean(value);
}

function checkCredentials(tenantId, username, password) {
  const cfg = getTenantConfig(tenantId);
  if (!cfg) return { ok: false, reason: 'invalid_tenant', configured: false };
  if (!isTenantEnabled(tenantId)) return { ok: false, reason: 'disabled', configured: false };

  if (cfg.credentialSource === 'dynamic') {
    return verifyDynamicTenantCredentials(tenantId, username, password);
  }

  const expectedUser = normalizeAuthValue(process.env[cfg.userEnv]);
  const expectedPass = normalizeAuthValue(process.env[cfg.passEnv]);
  if (!expectedUser || !expectedPass) {
    return { ok: false, reason: 'incomplete_configuration', configured: false };
  }

  const providedUser = normalizeAuthValue(username);
  const providedPass = normalizeAuthValue(password);
  const userOk = safeEqualText(providedUser, expectedUser);
  const passOk = safeEqualText(providedPass, expectedPass);
  return {
    ok: userOk && passOk,
    reason: userOk && passOk ? 'ok' : 'mismatch',
    configured: true,
    username: expectedUser,
  };
}

function verifyCredentials(tenantId, username, password) {
  return checkCredentials(tenantId, username, password).ok;
}

function logAuthAttempt(req, tenantId, username, check, rateLimited = false) {
  const enabled = clean(process.env.DEBUG_AUTH || process.env.DEBUG).toLowerCase();
  if (enabled === '0' || enabled === 'false' || enabled === 'off' || !enabled) return;
  const ip = req.socket?.remoteAddress || req.ip || '';
  console.log(
    `[AUTH] tenant=${tenantId} user=${maskIdentifier(username)} ok=${Boolean(check?.ok)} configured=${Boolean(check?.configured)} rateLimited=${Boolean(rateLimited)} ip=${maskIdentifier(ip)}`
  );
}

function unauthorized(req, res, tenantId) {
  res.setHeader('Cache-Control', 'no-store');
  if (wantsHtml(req)) {
    const cfg = getTenantConfig(tenantId);
    const next = encodeURIComponent(req.originalUrl || cfg?.path || '/');
    return res.redirect(`/login?tenant=${encodeURIComponent(tenantId)}&next=${next}`);
  }
  return res.status(401).json({ ok: false, error: 'Não foi possível autenticar.', login: `/login?tenant=${tenantId}` });
}

function forbiddenConfiguration(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(403).json({ ok: false, error: 'Acesso indisponível.' });
}

function tooManyAttempts(res, retryAfterMs) {
  const retryAfter = Math.max(1, Math.ceil(Number(retryAfterMs || 1000) / 1000));
  res.setHeader('Retry-After', String(retryAfter));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(429).json({ ok: false, error: 'Não foi possível autenticar. Tente novamente mais tarde.' });
}

function currentRoleForUser(tenantId) {
  const record = getDynamicTenant(tenantId);
  return record && record.enabled ? record.role : null;
}

function isSessionUserActive(tenantId, username) {
  const cfg = getTenantConfig(tenantId);
  if (cfg?.credentialSource === 'dynamic') return isDynamicTenantSessionUserActive(tenantId, username);
  return true;
}

function attachAuth(req, tenantId, session, method, roleOverride) {
  const role = roleOverride || currentRoleForUser(tenantId);
  const cfg = getTenantConfig(tenantId);
  if (cfg?.credentialSource === 'dynamic' && !role) return false;
  const context = buildAuthContext({
    tenantId,
    username: session.username,
    sessionId: session.sessionHash,
    method,
    role,
  });
  if (!context) return false;
  req.auth = context;
  return true;
}

function makeBasicAuth({ userEnv, passEnv, realm }) {
  const tenantId = tenantFromEnv(userEnv);

  return function persistentAuthMiddleware(req, res, next) {
    const cfg = getTenantConfig(tenantId);
    if (!cfg || cfg.userEnv !== userEnv || cfg.passEnv !== passEnv || cfg.realm !== realm) {
      return forbiddenConfiguration(req, res);
    }
    if (!isTenantEnabled(tenantId)) return forbiddenConfiguration(req, res);

    const expectedUser = normalizeAuthValue(process.env[userEnv]);
    const expectedPass = normalizeAuthValue(process.env[passEnv]);
    if (!expectedUser || !expectedPass) return forbiddenConfiguration(req, res);

    const session = readToken(req, tenantId);
    if (session) {
      if (!isSessionUserActive(tenantId, session.username)) {
        revokeTokenFromRequest(req, tenantId);
        clearAuthCookie(res, req, tenantId);
        return unauthorized(req, res, tenantId);
      }
      if (!attachAuth(req, tenantId, session, 'cookie')) return forbiddenConfiguration(req, res);
      return enforceTenantRequest(req, res, next, tenantId);
    }

    const creds = auth(req);
    if (!creds) return unauthorized(req, res, tenantId);

    const rate = loginRateLimiter.check(req, tenantId);
    if (rate.blocked) {
      logAuthAttempt(req, tenantId, creds.name, null, true);
      return tooManyAttempts(res, rate.retryAfterMs);
    }

    const check = checkCredentials(tenantId, creds.name, creds.pass);
    logAuthAttempt(req, tenantId, creds.name, check, false);
    if (!check.ok) {
      const failed = loginRateLimiter.recordFailure(req, tenantId);
      if (failed.blocked) return tooManyAttempts(res, failed.retryAfterMs);
      return unauthorized(req, res, tenantId);
    }

    loginRateLimiter.recordSuccess(req, tenantId);
    revokeTokenFromRequest(req, tenantId);
    try {
      const authenticatedUsername = normalizeAuthValue(check.username || creds.name);
      const token = createToken({ tenantId, username: authenticatedUsername, remember: true });
      setAuthCookie(res, req, tenantId, token, { remember: true });
      const active = readTokenValue(token, tenantId);
      if (!attachAuth(req, tenantId, active, 'basic', check.role)) return forbiddenConfiguration(req, res);
      return enforceTenantRequest(req, res, next, tenantId);
    } catch (error) {
      console.error('[SECURITY] Falha ao criar sessão:', safeError(error));
      return res.status(503).json({ ok: false, error: 'Autenticação temporariamente indisponível.' });
    }
  };
}

function makeTenantAuth(tenantIdInput) {
  const tenantId = normalizeAuthValue(tenantIdInput).toLowerCase();
  return function dynamicTenantAuthMiddleware(req, res, next) {
    const cfg = getTenantConfig(tenantId);
    if (!cfg || cfg.credentialSource !== 'dynamic' || !isTenantEnabled(tenantId)) {
      return forbiddenConfiguration(req, res);
    }

    const session = readToken(req, tenantId);
    if (session) {
      if (!isSessionUserActive(tenantId, session.username)) {
        revokeTokenFromRequest(req, tenantId);
        clearAuthCookie(res, req, tenantId);
        return unauthorized(req, res, tenantId);
      }
      if (!attachAuth(req, tenantId, session, 'cookie')) return forbiddenConfiguration(req, res);
      return enforceTenantRequest(req, res, next, tenantId);
    }

    const creds = auth(req);
    if (!creds) return unauthorized(req, res, tenantId);

    const rate = loginRateLimiter.check(req, tenantId);
    if (rate.blocked) {
      logAuthAttempt(req, tenantId, creds.name, null, true);
      return tooManyAttempts(res, rate.retryAfterMs);
    }

    const check = checkCredentials(tenantId, creds.name, creds.pass);
    logAuthAttempt(req, tenantId, creds.name, check, false);
    if (!check.ok) {
      const failed = loginRateLimiter.recordFailure(req, tenantId);
      if (failed.blocked) return tooManyAttempts(res, failed.retryAfterMs);
      return unauthorized(req, res, tenantId);
    }

    loginRateLimiter.recordSuccess(req, tenantId);
    revokeTokenFromRequest(req, tenantId);
    try {
      const authenticatedUsername = normalizeAuthValue(check.username || creds.name);
      const token = createToken({ tenantId, username: authenticatedUsername, remember: true });
      setAuthCookie(res, req, tenantId, token, { remember: true });
      const active = readTokenValue(token, tenantId);
      if (!attachAuth(req, tenantId, active, 'basic', check.role)) return forbiddenConfiguration(req, res);
      return enforceTenantRequest(req, res, next, tenantId);
    } catch (error) {
      console.error('[SECURITY] Falha ao criar sessão:', safeError(error));
      return res.status(503).json({ ok: false, error: 'Autenticação temporariamente indisponível.' });
    }
  };
}

function anyTenantAuth(req, res, next) {
  const enabledTenants = listTenantConfigs({ includeDisabled: false }).map((cfg) => cfg.tenantId);
  if (!enabledTenants.length) return forbiddenConfiguration(req, res);

  for (const tenantId of enabledTenants) {
    const session = readToken(req, tenantId);
    if (session) {
      if (!isSessionUserActive(tenantId, session.username)) {
        revokeTokenFromRequest(req, tenantId);
        clearAuthCookie(res, req, tenantId);
        continue;
      }
      if (!attachAuth(req, tenantId, session, 'cookie')) return forbiddenConfiguration(req, res);
      return enforceTenantRequest(req, res, next, tenantId);
    }
  }
  return unauthorized(req, res, 'admin');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderLoginPage() {
  const options = listTenantConfigs({ includeDisabled: false })
    .map((cfg) => `<option value="${escapeHtml(cfg.tenantId)}">${escapeHtml(cfg.displayName || cfg.realm || cfg.tenantId)}</option>`)
    .join('');
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Entrar • Zape</title>
  <link rel="stylesheet" href="/login.css" />
</head>
<body>
  <form class="card" id="form">
    <div class="logo">Z</div><h1>Entrar no painel</h1><div class="sub">Use as credenciais do seu painel.</div>
    <label for="tenant">Painel</label><select id="tenant" name="tenant">${options}</select>
    <label for="username">Usuário</label><input id="username" name="username" autocomplete="username" required />
    <label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="current-password" required />
    <label class="row"><input id="remember" type="checkbox" checked /> Manter conectado por 30 dias</label>
    <button id="btn" type="submit">Entrar</button><div id="err" class="err"></div><div class="foot">A senha não é salva no navegador. Use “Sair” para revogar a sessão atual.</div>
  </form>
  <script src="/login.js" defer></script>
</body>
</html>`;
}

function registerAuthRoutes(app) {
  app.get('/login', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderLoginPage());
  });

  app.post('/auth/login', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const tenantId = normalizeAuthValue(req.body?.tenant || '').toLowerCase();
    const username = normalizeAuthValue(req.body?.username || '');
    const password = normalizeAuthValue(req.body?.password || '');
    const remember = req.body?.remember !== false;
    const cfg = getTenantConfig(tenantId);

    const rate = loginRateLimiter.check(req, tenantId || 'unknown');
    if (rate.blocked) {
      logAuthAttempt(req, tenantId || 'unknown', username, null, true);
      auditAuth(req, 'login.rate_limited', tenantId || 'unknown', 'denied', { retryAfterMs: rate.retryAfterMs });
      return tooManyAttempts(res, rate.retryAfterMs);
    }

    const check = cfg ? checkCredentials(tenantId, username, password) : { ok: false, configured: false, reason: 'invalid_tenant' };
    logAuthAttempt(req, tenantId || 'unknown', username, check, false);
    if (!check.ok) {
      const failed = loginRateLimiter.recordFailure(req, tenantId || 'unknown');
      auditAuth(req, 'login.failed', tenantId || 'unknown', 'denied', { reason: check.reason || 'mismatch', rateLimited: failed.blocked });
      if (failed.blocked) return tooManyAttempts(res, failed.retryAfterMs);
      return res.status(401).json({ ok: false, error: 'Não foi possível autenticar.' });
    }

    loginRateLimiter.recordSuccess(req, tenantId);
    revokeTokenFromRequest(req, tenantId);
    try {
      const authenticatedUsername = normalizeAuthValue(check.username || username);
      const token = createToken({ tenantId, username: authenticatedUsername, remember });
      setAuthCookie(res, req, tenantId, token, { remember });
      setCsrfCookie(res, req);
      const session = readTokenValue(token, tenantId);
      req.auth = buildAuthContext({ tenantId, username: authenticatedUsername, sessionId: session?.sessionHash || '', method: 'login', role: check.role });
      auditAuth(req, 'login.success', tenantId, 'success', { remember: Boolean(remember) });
      return res.json({ ok: true, tenantId, next: cfg.path });
    } catch (error) {
      console.error('[SECURITY] Falha ao criar sessão:', safeError(error));
      return res.status(503).json({ ok: false, error: 'Autenticação temporariamente indisponível.' });
    }
  });

  app.post('/auth/logout', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const requested = normalizeAuthValue(req.body?.tenant || req.query?.tenant || '').toLowerCase();
    const tenants = requested && getTenantConfig(requested) ? [requested] : listTenantConfigs().map((cfg) => cfg.tenantId);
    for (const tenantId of tenants) {
      const active = readToken(req, tenantId);
      if (active && !req.auth) req.auth = buildAuthContext({ tenantId, username: active.username, sessionId: active.sessionHash, method: 'logout' });
      revokeTokenFromRequest(req, tenantId);
      clearAuthCookie(res, req, tenantId);
      if (active) auditAuth(req, 'logout', tenantId, 'success');
    }
    clearCsrfCookie(res, req);
    return res.json({ ok: true });
  });
}

module.exports = {
  makeBasicAuth,
  makeTenantAuth,
  anyTenantAuth,
  registerAuthRoutes,
  checkCredentials,
  verifyCredentials,
  __test: {
    getSecret,
    parseCookies,
    cookieName,
    createToken,
    verifySignedToken,
    readTokenValue,
    setAuthCookie,
    clearAuthCookie,
    revokeTokenFromRequest,
    loginRateLimiter,
    safeEqualText,
  },
};
