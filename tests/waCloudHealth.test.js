'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

async function withCloudEnv(fetchImpl, fn) {
  const keys = [
    'ZAPE_DATA_DIR', 'CONFIG_ENCRYPTION_KEY', 'WA_CLOUD_ENABLED', 'WA_CLOUD_FORCE_ENV', 'WA_CLOUD_TOKEN',
    'WA_CLOUD_PHONE_NUMBER_ID', 'WA_CLOUD_WABA_ID', 'WA_CLOUD_GRAPH_VERSION', 'WA_CLOUD_WEBHOOK_VERIFY_TOKEN',
    'WA_EMBEDDED_APP_ID', 'WA_EMBEDDED_APP_SECRET',
  ];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const oldFetch = global.fetch;
  process.env.ZAPE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-cloud-health-'));
  process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  process.env.WA_CLOUD_ENABLED = '1';
  process.env.WA_CLOUD_FORCE_ENV = '1';
  process.env.WA_CLOUD_TOKEN = 'synthetic-token';
  process.env.WA_CLOUD_PHONE_NUMBER_ID = '100';
  process.env.WA_CLOUD_WABA_ID = '200';
  process.env.WA_CLOUD_GRAPH_VERSION = 'v25.0';
  process.env.WA_CLOUD_WEBHOOK_VERIFY_TOKEN = 'synthetic-verify-token';
  process.env.WA_EMBEDDED_APP_ID = '300';
  process.env.WA_EMBEDDED_APP_SECRET = 'synthetic-secret';
  global.fetch = fetchImpl;
  for (const mod of ['../src/waCloud', '../src/waCloudConfigStore']) delete require.cache[require.resolve(mod)];
  try { return await fn(require('../src/waCloud')); }
  finally {
    global.fetch = oldFetch;
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
  }
}

test('health check confirma token, número, WABA, webhook e template sem expor token', async () => {
  await withCloudEnv(async (url) => {
    const text = String(url);
    if (text.includes('/debug_token?')) return response(200, { data: { is_valid: true, expires_at: 9999999999 } });
    if (text.includes('/100?fields=')) return response(200, { id: '100', display_phone_number: '+55 11 99999-9999', verified_name: 'Empresa Teste', platform_type: 'CLOUD_API', code_verification_status: 'VERIFIED' });
    if (text.includes('/200/subscribed_apps')) return response(200, { data: [{ id: '300' }] });
    if (text.includes('/200/message_templates')) return response(200, { data: [{ id: 'tpl_1', name: 'teste', status: 'APPROVED' }] });
    if (text.includes('/200?fields=')) return response(200, { id: '200', name: 'WABA Teste' });
    throw new Error(`URL inesperada: ${text}`);
  }, async ({ runCloudHealthCheck }) => {
    const health = await runCloudHealthCheck();
    assert.equal(health.ok, true);
    assert.equal(health.status, 'healthy');
    assert.ok(health.connection.connectionId);
    assert.equal(JSON.stringify(health).includes('synthetic-token'), false);
    assert.equal(health.checks.find((row) => row.key === 'webhook_subscribed').ok, true);
    assert.equal(health.checks.find((row) => row.key === 'template_consultable').ok, true);
  });
});

test('health check traduz #133010 como número não registrado', async () => {
  await withCloudEnv(async (url) => {
    const text = String(url);
    if (text.includes('/100?fields=')) return response(400, { error: { code: 133010, message: 'Account not registered', type: 'OAuthException' } });
    if (text.includes('/debug_token?')) return response(200, { data: { is_valid: true } });
    if (text.includes('/200/subscribed_apps')) return response(200, { data: [{ id: '300' }] });
    if (text.includes('/200/message_templates')) return response(200, { data: [] });
    if (text.includes('/200?fields=')) return response(200, { id: '200', name: 'WABA Teste' });
    throw new Error(`URL inesperada: ${text}`);
  }, async ({ runCloudHealthCheck }) => {
    const health = await runCloudHealthCheck();
    assert.equal(health.ok, false);
    assert.equal(health.error.code, 133010);
    assert.equal(health.checks.find((row) => row.key === 'number_registration').status, 'not_registered');
    assert.match(health.error.action, /Registre o número|refaça o vínculo/i);
  });
});
