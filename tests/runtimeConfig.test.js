'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateRuntimeConfiguration,
  applyTrustProxy,
} = require('../src/runtimeConfig');
const { clientIp } = require('../src/loginRateLimiter');
const { resolveClientIp } = require('../src/webhookSecurity');

function secureEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: '3000',
    TRUST_PROXY_HOPS: '1',
    PUBLIC_BASE_URL: 'https://zape.example.invalid',
    AUTH_TRUST_PROXY_HEADERS: '1',
    PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS: '1',
    ...overrides,
  };
}

test('produção aceita somente bind local, HTTPS, proxy numérico e usuário não-root', () => {
  const result = validateRuntimeConfiguration({ env: secureEnv(), mode: 'production', uid: 1001 });
  assert.equal(result.ok, true, result.errors.join(' '));
  assert.equal(result.host, '127.0.0.1');
  assert.equal(result.trustProxyHops, 1);
});

test('produção rejeita bind público, trust proxy irrestrito, HTTP e root', () => {
  const cases = [
    secureEnv({ HOST: '0.0.0.0' }),
    secureEnv({ TRUST_PROXY_HOPS: 'true' }),
    secureEnv({ PUBLIC_BASE_URL: 'http://zape.example.invalid' }),
  ];
  for (const env of cases) {
    const result = validateRuntimeConfiguration({ env, mode: 'production', uid: 1001 });
    assert.equal(result.ok, false);
  }
  const root = validateRuntimeConfiguration({ env: secureEnv(), mode: 'production', uid: 0 });
  assert.equal(root.ok, false);
  assert.match(root.errors.join(' '), /root/i);
});

test('cabeçalhos encaminhados exigem trust proxy ativo', () => {
  const result = validateRuntimeConfiguration({
    env: secureEnv({ TRUST_PROXY_HOPS: '0' }),
    mode: 'production',
    uid: 1001,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /TRUST_PROXY_HOPS|Cabeçalhos de proxy/);
});

test('applyTrustProxy nunca configura true irrestrito', () => {
  const calls = [];
  const app = {
    set(name, value) { calls.push(['set', name, value]); },
    disable(name) { calls.push(['disable', name]); },
  };
  applyTrustProxy(app, 1);
  applyTrustProxy(app, 0);
  assert.deepEqual(calls, [
    ['set', 'trust proxy', 1],
    ['disable', 'trust proxy'],
  ]);
});

test('rate limit usa req.ip calculado pelo Express e ignora X-Forwarded-For bruto', () => {
  const previousAuth = process.env.AUTH_TRUST_PROXY_HEADERS;
  const previousPublic = process.env.PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS;
  process.env.AUTH_TRUST_PROXY_HEADERS = '1';
  process.env.PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS = '1';
  try {
    const req = {
      ip: '203.0.113.20',
      headers: { 'x-forwarded-for': '198.51.100.99' },
      get(name) { return this.headers[String(name).toLowerCase()]; },
      socket: { remoteAddress: '127.0.0.1' },
    };
    assert.equal(clientIp(req), '203.0.113.20');
    assert.equal(resolveClientIp(req, true), '203.0.113.20');
  } finally {
    if (previousAuth === undefined) delete process.env.AUTH_TRUST_PROXY_HEADERS;
    else process.env.AUTH_TRUST_PROXY_HEADERS = previousAuth;
    if (previousPublic === undefined) delete process.env.PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS;
    else process.env.PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS = previousPublic;
  }
});
