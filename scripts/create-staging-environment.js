#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const arg = (name, fallback) => {
  const found = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const outputDir = path.resolve(arg('output', path.join(ROOT, 'tmp', 'staging-phase15')));
const force = process.argv.includes('--force');
if (fs.existsSync(outputDir) && !force) {
  throw new Error(`Destino já existe: ${outputDir}. Use --force para recriar.`);
}
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const dataDir = path.join(outputDir, 'data');
const fixture = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'create-sanitized-fixture.js'), `--output=${dataDir}`, '--force'], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (fixture.status !== 0) throw new Error(fixture.stderr || fixture.stdout);

const secret = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const encryptionKey = crypto.randomBytes(32).toString('base64');
const databaseUrl = arg('database-url', 'postgresql://zape_staging:zape_staging@127.0.0.1:55432/zape_staging');
const redisUrl = arg('redis-url', 'redis://127.0.0.1:56379/15');
const port = arg('port', '3300');
const env = {
  NODE_ENV: 'staging',
  HOST: '127.0.0.1',
  PORT: port,
  PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  ZAPE_DATA_DIR: dataDir,
  SESSION_STORE_FILE: path.join(outputDir, 'runtime', 'auth_sessions.json'),
  SECURITY_AUDIT_FILE: path.join(outputDir, 'runtime', 'security_audit.jsonl'),
  STRUCTURED_LOG_FILE: path.join(outputDir, 'runtime', 'application.jsonl'),
  ALERT_STATE_FILE: path.join(outputDir, 'runtime', 'alerts.json'),
  WEBHOOK_EVENT_STORE_FILE: path.join(outputDir, 'runtime', 'webhook_events.json'),
  BACKUP_DIRECTORY: path.join(outputDir, 'backups'),
  BACKUP_REMOTE_DIRECTORY: path.join(outputDir, 'offsite-backups'),
  SESSION_SECRET: secret(48),
  CONFIG_ENCRYPTION_KEY: encryptionKey,
  BACKUP_ENCRYPTION_KEY: encryptionKey,
  PERSISTENCE_MODE: 'database',
  DATABASE_URL: databaseUrl,
  DATABASE_SSL: '0',
  DATABASE_CONNECTION_TIMEOUT_MS: '3000',
  REDIS_URL: redisUrl,
  WEBJS_ENABLED: '0',
  WEBJS_AUTO_START: '0',
  WA_CLOUD_ENABLED: '0',
  CRM_INTEGRATION_ENABLED: '0',
  PUBLIC_LEAD_FORM_ENABLED: '0',
  ACTIVECAMPAIGN_WEBHOOK_ENABLED: '0',
  CUSTOM_WEBHOOK_REQUIRE_SIGNATURE: '1',
  ENABLE_DEBUG_ACTIVE: '0',
  DATA_INTEGRITY_VALIDATE_ON_BOOT: '1',
  STAGING_SYNTHETIC_ONLY: '1',
  STAGING_ENVIRONMENT_ID: `phase15-${crypto.randomBytes(8).toString('hex')}`,
};
for (const tenant of ['admin', 'panel', 'regina', 'portugal', 'felipe', 'ana']) {
  const prefix = tenant.toUpperCase();
  env[`${prefix}_ENABLED`] = '1';
  env[`${prefix}_USER`] = `${tenant}_staging_${crypto.randomBytes(4).toString('hex')}`;
  env[`${prefix}_PASS`] = secret(32);
}
const envFile = path.join(outputDir, 'staging.env');
fs.writeFileSync(envFile, Object.entries(env).map(([key, value]) => `${key}=${String(value).replace(/\n/g, '')}`).join('\n') + '\n', { mode: 0o600 });
const manifest = {
  schemaVersion: 1,
  phase: 15,
  syntheticOnly: true,
  generatedAt: new Date().toISOString(),
  outputDir,
  dataDir,
  envFile,
  database: { isolated: true, urlHash: crypto.createHash('sha256').update(databaseUrl).digest('hex') },
  redis: { isolated: true, urlHash: crypto.createHash('sha256').update(redisUrl).digest('hex') },
  integrations: { whatsappWeb: false, cloudApi: false, externalCrm: false },
  fixture: JSON.parse(fixture.stdout),
};
fs.writeFileSync(path.join(outputDir, 'staging-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(manifest, null, 2));
