'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { buildHelmetMiddleware, buildCorsMiddleware, securityResponseHeaders } = require('../src/httpSecurity');

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Helmet publica CSP, anti-frame, nosniff, referrer e permissions policy', async () => {
  const app = express();
  app.use(buildHelmetMiddleware());
  app.use(securityResponseHeaders);
  app.get('/admin', (_req, res) => res.type('html').send('<!doctype html><title>ok</title>'));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin`);
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src-attr 'none'/);
    assert.match(csp, /style-src-elem 'self' https:\/\/fonts\.googleapis\.com/);
    assert.match(csp, /style-src-attr 'unsafe-inline'/);
    assert.match(csp, /require-trusted-types-for 'script'/);
    assert.match(csp, /trusted-types default dompurify/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.match(response.headers.get('permissions-policy') || '', /camera=\(\)/);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    assert.equal(response.headers.has('strict-transport-security'), false);
  });
});

test('CORS não reflete qualquer origem e aceita somente allowlist explícita', async () => {
  const previous = process.env.APP_ALLOWED_ORIGINS;
  process.env.APP_ALLOWED_ORIGINS = 'https://allowed.example';
  try {
    const app = express();
    app.use(buildCorsMiddleware());
    app.get('/health', (_req, res) => res.json({ ok: true }));
    await withServer(app, async (baseUrl) => {
      const allowed = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://allowed.example' } });
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://allowed.example');
      assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');

      const denied = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://evil.example' } });
      assert.equal(denied.headers.has('access-control-allow-origin'), false);
    });
  } finally {
    if (previous === undefined) delete process.env.APP_ALLOWED_ORIGINS;
    else process.env.APP_ALLOWED_ORIGINS = previous;
  }
});
