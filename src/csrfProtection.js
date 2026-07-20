'use strict';

const crypto = require('crypto');

const CSRF_COOKIE_NAME = 'zape_csrf';
const CSRF_HEADER_NAME = 'x-zape-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function parseCookies(req) {
  const header = String(req?.headers?.cookie || '');
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); }
    catch { out[key] = value; }
  }
  return out;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function isSecureRequest(req) {
  if (clean(process.env.NODE_ENV).toLowerCase() === 'production') return true;
  const forwarded = String(req?.get?.('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  return Boolean(req?.secure || forwarded === 'https');
}

function setCsrfCookie(res, req, token = createCsrfToken(), { maxAgeSeconds = 30 * 24 * 60 * 60 } = {}) {
  const attrs = [
    `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'SameSite=Strict',
    'Priority=High',
    `Max-Age=${Math.max(60, Number(maxAgeSeconds) || 0)}`,
  ];
  if (isSecureRequest(req)) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
  return token;
}

function clearCsrfCookie(res, req) {
  const attrs = [
    `${CSRF_COOKIE_NAME}=`,
    'Path=/',
    'SameSite=Strict',
    'Priority=High',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (isSecureRequest(req)) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function parseAllowedOrigins(value = process.env.APP_ALLOWED_ORIGINS || process.env.CORS_ALLOWED_ORIGINS || '') {
  return new Set(String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try { return new URL(item).origin; }
      catch { return ''; }
    })
    .filter(Boolean));
}

function requestOrigin(req) {
  const direct = clean(req?.get?.('origin'));
  if (direct) {
    try { return new URL(direct).origin; }
    catch { return ''; }
  }
  const referer = clean(req?.get?.('referer'));
  if (referer) {
    try { return new URL(referer).origin; }
    catch { return ''; }
  }
  return '';
}

function expectedSameOrigin(req) {
  const host = clean(req?.get?.('host'));
  if (!host || /[\r\n]/.test(host)) return '';
  const protocol = req?.secure || clean(req?.get?.('x-forwarded-proto')).split(',')[0].trim().toLowerCase() === 'https'
    ? 'https'
    : 'http';
  try { return new URL(`${protocol}://${host}`).origin; }
  catch { return ''; }
}

function isOriginAllowed(req, { extraAllowedOrigins = parseAllowedOrigins() } = {}) {
  const origin = requestOrigin(req);
  if (!origin) return false;
  const expected = expectedSameOrigin(req);
  return origin === expected || extraAllowedOrigins.has(origin);
}

function isPublicUnsafePath(pathname) {
  const path = String(pathname || '').split('?')[0];
  return path === '/api/leads'
    || path === '/webhooks/activecampaign'
    || path === '/webhooks/wa-cloud'
    || /^\/webhooks\/[^/]+$/.test(path);
}

function needsCsrfProtection(req) {
  const method = String(req?.method || 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return false;
  const path = String(req?.path || req?.url || '').split('?')[0];
  if (isPublicUnsafePath(path)) return false;
  return path === '/auth/logout' || path.startsWith('/api/');
}

function reject(res, status, code, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ ok: false, error: message, code });
}

function validateCsrfRequest(req, options = {}) {
  if (!needsCsrfProtection(req)) return { ok: true, skipped: true };
  if (!isOriginAllowed(req, options)) return { ok: false, status: 403, code: 'ORIGIN_NOT_ALLOWED' };
  const cookieToken = clean(parseCookies(req)[CSRF_COOKIE_NAME]);
  const headerToken = clean(req?.get?.(CSRF_HEADER_NAME));
  if (!cookieToken || !headerToken) return { ok: false, status: 403, code: 'CSRF_TOKEN_MISSING' };
  if (!safeEqual(cookieToken, headerToken)) return { ok: false, status: 403, code: 'CSRF_TOKEN_INVALID' };
  return { ok: true };
}

function csrfProtection(options = {}) {
  return function csrfProtectionMiddleware(req, res, next) {
    const result = validateCsrfRequest(req, options);
    if (result.ok) return next();
    const message = result.code === 'ORIGIN_NOT_ALLOWED'
      ? 'Origem da requisição não autorizada.'
      : 'Proteção CSRF inválida ou ausente.';
    return reject(res, result.status || 403, result.code || 'CSRF_REJECTED', message);
  };
}

function loginOriginProtection(options = {}) {
  return function loginOriginMiddleware(req, res, next) {
    if (String(req.method || '').toUpperCase() !== 'POST' || req.path !== '/auth/login') return next();
    if (isOriginAllowed(req, options)) return next();
    return reject(res, 403, 'ORIGIN_NOT_ALLOWED', 'Origem da requisição não autorizada.');
  };
}

module.exports = {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SAFE_METHODS,
  parseCookies,
  safeEqual,
  createCsrfToken,
  setCsrfCookie,
  clearCsrfCookie,
  parseAllowedOrigins,
  requestOrigin,
  expectedSameOrigin,
  isOriginAllowed,
  isPublicUnsafePath,
  needsCsrfProtection,
  validateCsrfRequest,
  csrfProtection,
  loginOriginProtection,
};
