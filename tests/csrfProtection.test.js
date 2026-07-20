'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createCsrfToken,
  needsCsrfProtection,
  validateCsrfRequest,
  isOriginAllowed,
  parseAllowedOrigins,
} = require('../src/csrfProtection');

function request({ method = 'POST', path = '/api/admin/leads/manual', origin = 'https://zape.example', host = 'zape.example', token = '', cookie = '' } = {}) {
  const headers = {
    origin,
    host,
    cookie: cookie || (token ? `zape_csrf=${encodeURIComponent(token)}` : ''),
    'x-zape-csrf-token': token,
  };
  return {
    method,
    path,
    url: path,
    secure: true,
    headers,
    get(name) { return headers[String(name).toLowerCase()] || ''; },
  };
}

test('operações autenticadas de escrita exigem origem e token CSRF iguais', () => {
  const token = createCsrfToken();
  const valid = validateCsrfRequest(request({ token }));
  assert.equal(valid.ok, true);

  const missing = validateCsrfRequest(request());
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'CSRF_TOKEN_MISSING');

  const mismatch = validateCsrfRequest(request({ token, cookie: 'zape_csrf=outro-token' }));
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'CSRF_TOKEN_INVALID');
});

test('origem cruzada ou ausente é rejeitada antes da operação crítica', () => {
  const token = createCsrfToken();
  const cross = validateCsrfRequest(request({ token, origin: 'https://evil.example' }));
  assert.equal(cross.ok, false);
  assert.equal(cross.code, 'ORIGIN_NOT_ALLOWED');

  const absent = validateCsrfRequest(request({ token, origin: '' }));
  assert.equal(absent.ok, false);
  assert.equal(absent.code, 'ORIGIN_NOT_ALLOWED');
});

test('webhooks públicos não usam cookie CSRF e métodos seguros são ignorados', () => {
  assert.equal(needsCsrfProtection(request({ path: '/webhooks/wa-cloud' })), false);
  assert.equal(needsCsrfProtection(request({ path: '/webhooks/token-forte' })), false);
  assert.equal(needsCsrfProtection(request({ path: '/api/leads' })), false);
  assert.equal(needsCsrfProtection(request({ method: 'GET', path: '/api/admin/leads' })), false);
});

test('allowlist adicional aceita apenas origens válidas normalizadas', () => {
  const allowed = parseAllowedOrigins('https://app.example/path,invalid,https://outro.example');
  assert.deepEqual([...allowed].sort(), ['https://app.example', 'https://outro.example']);
  const req = request({ origin: 'https://app.example', host: 'zape.example' });
  assert.equal(isOriginAllowed(req, { extraAllowedOrigins: allowed }), true);
});
