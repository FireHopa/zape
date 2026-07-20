const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const script = path.join(__dirname, '..', 'scripts', 'migrate-secrets.js');

function run(args, env) {
  return childProcess.execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('migração faz dry-run, backup, apply idempotente e rollback sem expor valores', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-secret-migration-'));
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backup');
  fs.mkdirSync(dataDir);
  const appSecret = 'synthetic-legacy-app-secret';
  const webhookToken = 'synthetic-legacy-webhook-token';
  const cloudFile = path.join(dataDir, 'wa_cloud_config.json');
  const webhooksFile = path.join(dataDir, 'webhooks.json');
  fs.writeFileSync(cloudFile, JSON.stringify({ appSecret, phoneNumberId: '100', wabaId: '200' }));
  fs.writeFileSync(webhooksFile, JSON.stringify([{ id: 'w1', tenantId: 'admin', token: webhookToken }]));
  const beforeCloud = fs.readFileSync(cloudFile, 'utf8');
  const env = { CONFIG_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') };

  const dry = run(['--data-dir', dataDir], env);
  assert.equal(dry.includes(appSecret), false);
  assert.equal(dry.includes(webhookToken), false);
  assert.equal(fs.readFileSync(cloudFile, 'utf8'), beforeCloud);

  run(['--data-dir', dataDir, '--apply', '--backup-dir', backupDir], env);
  const migratedCloud = fs.readFileSync(cloudFile, 'utf8');
  const migratedWebhooks = fs.readFileSync(webhooksFile, 'utf8');
  assert.equal(migratedCloud.includes(appSecret), false);
  assert.equal(migratedWebhooks.includes(webhookToken), false);
  assert.ok(fs.existsSync(path.join(backupDir, 'manifest.json')));

  const second = JSON.parse(run(['--data-dir', dataDir], env));
  assert.equal(second.cloud.changed, false);
  assert.equal(second.webhooks.changed, false);

  run(['--data-dir', dataDir, '--rollback', backupDir], env);
  assert.equal(fs.readFileSync(cloudFile, 'utf8'), beforeCloud);
});
