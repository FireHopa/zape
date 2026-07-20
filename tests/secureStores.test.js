const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function withEnv(dataDir, fn) {
  const old = { dir: process.env.ZAPE_DATA_DIR, key: process.env.CONFIG_ENCRYPTION_KEY, legacy: process.env.ALLOW_LEGACY_PLAINTEXT_SECRETS };
  process.env.ZAPE_DATA_DIR = dataDir;
  process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  process.env.ALLOW_LEGACY_PLAINTEXT_SECRETS = '0';
  try { return fn(); }
  finally {
    if (old.dir === undefined) delete process.env.ZAPE_DATA_DIR; else process.env.ZAPE_DATA_DIR = old.dir;
    if (old.key === undefined) delete process.env.CONFIG_ENCRYPTION_KEY; else process.env.CONFIG_ENCRYPTION_KEY = old.key;
    if (old.legacy === undefined) delete process.env.ALLOW_LEGACY_PLAINTEXT_SECRETS; else process.env.ALLOW_LEGACY_PLAINTEXT_SECRETS = old.legacy;
  }
}

test('Cloud config persiste App Secret e token somente criptografados', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-cloud-store-'));
  withEnv(dataDir, () => {
    const store = fresh('../src/waCloudConfigStore');
    const appSecret = 'synthetic-app-secret-value';
    const accessToken = 'synthetic-access-token-value';
    store.writeStoredConfig({ appSecret, accessToken, phoneNumberId: '100', wabaId: '200' });
    const disk = fs.readFileSync(path.join(dataDir, 'wa_cloud_config.json'), 'utf8');
    assert.equal(disk.includes(appSecret), false);
    assert.equal(disk.includes(accessToken), false);
    const runtime = store.readStoredConfig();
    assert.equal(runtime.appSecret, appSecret);
    assert.equal(runtime.accessToken, accessToken);
  });
});

test('Webhook token é retornado na criação, mas não fica em texto puro no JSON', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-webhook-store-'));
  withEnv(dataDir, () => {
    const store = fresh('../src/webhooksStore');
    const created = store.createWebhook('admin', { name: 'Webhook sintético' });
    assert.ok(created.token.length >= 32);
    const disk = fs.readFileSync(path.join(dataDir, 'webhooks.json'), 'utf8');
    assert.equal(disk.includes(created.token), false);
    assert.equal(store.resolveWebhookToken(created.token).id, created.id);
  });
});
