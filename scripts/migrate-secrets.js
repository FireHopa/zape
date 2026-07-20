#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { encryptSecret, isEncryptedSecret, requireKey } = require('../src/secretVault');
const { sanitizeEmbeddedSession, sanitizeTokenDebug } = require('../src/waCloudConfigStore');

function parseArgs(argv) {
  const out = { apply: false, dataDir: process.env.ZAPE_DATA_DIR || path.join(__dirname, '..', 'data'), backupDir: '', rollback: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--data-dir') out.dataDir = argv[++i];
    else if (arg === '--backup-dir') out.backupDir = argv[++i];
    else if (arg === '--rollback') out.rollback = argv[++i];
    else if (arg === '--help') out.help = true;
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  out.dataDir = path.resolve(out.dataDir);
  return out;
}

function hashFile(file) {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function migrateCloud(raw) {
  const next = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  const encryptedSecrets = next.encryptedSecrets && typeof next.encryptedSecrets === 'object' ? { ...next.encryptedSecrets } : {};
  const appSecret = String(next.appSecret || '').trim();
  const accessToken = String(next.accessToken || next.access_token || next.token || '').trim();
  const detected = [];

  if (appSecret) detected.push('appSecret');
  if (accessToken) detected.push('accessToken');
  if (appSecret && !isEncryptedSecret(encryptedSecrets.appSecret)) encryptedSecrets.appSecret = encryptSecret(appSecret);
  if (accessToken && !isEncryptedSecret(encryptedSecrets.accessToken)) encryptedSecrets.accessToken = encryptSecret(accessToken);

  ['appSecret', 'accessToken', 'access_token', 'token'].forEach((key) => delete next[key]);
  next.schemaVersion = 2;
  next.encryptedSecrets = encryptedSecrets;
  if (!Object.keys(encryptedSecrets).length) delete next.encryptedSecrets;
  if (next.lastEmbeddedSession) next.lastEmbeddedSession = sanitizeEmbeddedSession(next.lastEmbeddedSession);
  if (next.lastTokenDebug) next.lastTokenDebug = sanitizeTokenDebug(next.lastTokenDebug);

  return {
    next,
    changed: JSON.stringify(raw || {}) !== JSON.stringify(next),
    detected,
    encrypted: {
      appSecret: isEncryptedSecret(encryptedSecrets.appSecret),
      accessToken: isEncryptedSecret(encryptedSecrets.accessToken),
    },
  };
}

function migrateWebhooks(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let plaintextTokens = 0;
  let encryptedTokens = 0;
  const next = list.map((row) => {
    const item = { ...row, schemaVersion: 2 };
    const token = String(item.token || '').trim();
    if (token) {
      plaintextTokens++;
      if (!isEncryptedSecret(item.tokenEncrypted)) item.tokenEncrypted = encryptSecret(token);
      item.tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      delete item.token;
    }
    if (isEncryptedSecret(item.tokenEncrypted)) encryptedTokens++;
    return item;
  });
  return {
    next,
    changed: JSON.stringify(list) !== JSON.stringify(next),
    plaintextTokens,
    encryptedTokens,
    total: list.length,
  };
}

function backupFiles(files, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const manifest = { createdAt: new Date().toISOString(), files: [] };
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const target = path.join(backupDir, path.basename(file));
    fs.copyFileSync(file, target);
    fs.chmodSync(target, 0o600);
    manifest.files.push({ name: path.basename(file), sha256: hashFile(file) });
  }
  atomicWrite(path.join(backupDir, 'manifest.json'), manifest);
  return manifest;
}

function rollback(dataDir, backupDir) {
  const manifestFile = path.join(backupDir, 'manifest.json');
  const manifest = readJson(manifestFile, null);
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('Backup inválido: manifest.json ausente.');
  for (const item of manifest.files) {
    const source = path.join(backupDir, item.name);
    if (!fs.existsSync(source) || hashFile(source) !== item.sha256) throw new Error(`Backup corrompido: ${item.name}`);
    const target = path.join(dataDir, item.name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
  }
  console.log(JSON.stringify({ ok: true, action: 'rollback', restoredFiles: manifest.files.map((item) => item.name) }, null, 2));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Uso: node scripts/migrate-secrets.js [--data-dir DIR] [--apply] [--backup-dir DIR] | --rollback BACKUP_DIR');
    return;
  }
  if (args.rollback) return rollback(args.dataDir, path.resolve(args.rollback));

  requireKey();
  const cloudFile = path.join(args.dataDir, 'wa_cloud_config.json');
  const webhooksFile = path.join(args.dataDir, 'webhooks.json');
  const cloudRaw = readJson(cloudFile, {});
  const webhooksRaw = readJson(webhooksFile, []);
  const cloud = migrateCloud(cloudRaw);
  const webhooks = migrateWebhooks(webhooksRaw);
  const changedFiles = [];
  if (cloud.changed && fs.existsSync(cloudFile)) changedFiles.push(cloudFile);
  if (webhooks.changed && fs.existsSync(webhooksFile)) changedFiles.push(webhooksFile);

  const report = {
    ok: true,
    mode: args.apply ? 'apply' : 'dry-run',
    dataDir: args.dataDir,
    before: { cloudSha256: hashFile(cloudFile), webhooksSha256: hashFile(webhooksFile) },
    cloud: { changed: cloud.changed, plaintextSecretTypes: cloud.detected, encrypted: cloud.encrypted },
    webhooks: { changed: webhooks.changed, total: webhooks.total, plaintextTokens: webhooks.plaintextTokens, encryptedTokensAfter: webhooks.encryptedTokens },
    filesToChange: changedFiles.map((file) => path.basename(file)),
  };

  if (args.apply && changedFiles.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.resolve(args.backupDir || path.join(args.dataDir, '..', 'backups', 'secrets-migration', stamp));
    report.backup = { directory: backupDir, manifest: backupFiles(changedFiles, backupDir) };
    if (cloud.changed) atomicWrite(cloudFile, cloud.next);
    if (webhooks.changed) atomicWrite(webhooksFile, webhooks.next);
    report.after = { cloudSha256: hashFile(cloudFile), webhooksSha256: hashFile(webhooksFile) };
  }
  console.log(JSON.stringify(report, null, 2));
}

try { main(); } catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || 'MIGRATION_FAILED', error: error.message }, null, 2));
  process.exitCode = 1;
}
