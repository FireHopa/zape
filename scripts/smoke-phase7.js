#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  auditDataDirectory,
  buildMigrationPlan,
  applyMigrationPlan,
  rollbackMigration,
  fileSha256,
  sha256,
} = require('../src/dataIntegrity');

const ROOT = path.resolve(__dirname, '..');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFile = outputArg ? path.resolve(outputArg.slice('--output='.length)) : '';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
}
function buildFixture(dataDir) {
  const dir = path.join(dataDir, 'admin');
  const mediaDir = path.join(dir, 'conversation_media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, 'one.bin'), 'same');
  fs.writeFileSync(path.join(mediaDir, 'two.bin'), 'same');
  const phone = '5511999999999';
  writeJsonl(path.join(dir, 'leads.jsonl'), [
    { id: 'a', nome: 'Lead A', whatsapp_digits: phone, createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'b', empresa: 'Empresa B', whatsapp_raw: '(11) 99999-9999', createdAt: '2024-01-02T00:00:00.000Z' },
  ]);
  writeJson(path.join(dir, 'conversations.json'), {
    [phone]: [
      { id: 'm1', body: 'arquivo', timestamp: 1, mediaFile: 'two.bin', hasMedia: true },
      { id: 'm2', body: 'ausente', timestamp: 2, mediaFile: 'missing.bin', hasMedia: true },
    ],
    0: [{ id: 'bad', body: 'bad' }],
  });
  writeJson(path.join(dir, 'message_status.json'), { [phone]: { ack: 2 }, 999: { ack: 1 } });
  writeJson(path.join(dir, 'crm.json'), { version: 1, activePipelineId: 'p', pipelines: [{ id: 'p', stageOrder: ['s'], stages: { s: { id: 's', leadIds: ['b'] } } }] });
  writeJson(path.join(dir, 'tags.json'), []);
  writeJson(path.join(dir, 'lead_tags.json'), {});
}
function treeDigest(root) {
  const rows = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else rows.push(`${path.relative(root, full)}:${fileSha256(full)}:${fs.statSync(full).size}`);
    }
  }
  walk(root);
  return sha256(rows.join('\n'));
}
async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
async function startServer(dataDir, port) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    ZAPE_DATA_DIR: dataDir,
    DATA_INTEGRITY_VALIDATE_ON_BOOT: '1',
    DATA_INTEGRITY_STRICT_BOOT: '1',
    ADMIN_ENABLED: '0', PANEL_ENABLED: '0', REGINA_ENABLED: '0', PORTUGAL_ENABLED: '0', FELIPE_ENABLED: '0', ANA_ENABLED: '0',
    WEBJS_ENABLED: '0', WEBJS_AUTO_START: '0', CRM_INTEGRATION_ENABLED: '0', WA_CLOUD_ENABLED: '0',
    PUBLIC_LEAD_FORM_ENABLED: '0', ACTIVECAMPAIGN_WEBHOOK_ENABLED: '0', ENABLE_DEBUG_ACTIVE: '0',
  };
  let stdout = ''; let stderr = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return { child, output: () => ({ stdout, stderr }) };
}
async function waitForHealth(baseUrl, child, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) return false;
    try { const response = await fetch(`${baseUrl}/health`); if (response.status === 200) return true; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
async function waitExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting exit')), timeoutMs)),
  ]);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-phase7-smoke-'));
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backup');
  const evidence = { phase: 7, syntheticOnly: true, generatedAt: new Date().toISOString(), checks: {} };
  let running;
  try {
    buildFixture(dataDir);
    const beforeDigest = treeDigest(dataDir);
    const auditBefore = auditDataDirectory(dataDir);
    assert.equal(auditBefore.summary.duplicatePhoneGroups, 1);
    assert.equal(auditBefore.summary.invalidConversationKeys, 1);
    assert.equal(auditBefore.summary.orphanStatuses, 1);
    assert.equal(auditBefore.summary.missingMediaReferences, 1);
    assert.equal(auditBefore.summary.duplicateMediaFiles, 1);
    evidence.checks.audit = auditBefore.summary;

    const plan = buildMigrationPlan(dataDir, { retentionDays: 30 });
    assert.equal(treeDigest(dataDir), beforeDigest);
    evidence.checks.dryRunUnchanged = true;

    const applied = applyMigrationPlan(dataDir, plan, {
      confirm: 'APPLY_DATA_INTEGRITY',
      confirmMedia: 'QUARANTINE_ORPHAN_MEDIA',
      backupDir,
    });
    const auditAfter = auditDataDirectory(dataDir);
    assert.equal(auditAfter.summary.duplicatePhoneGroups, 0);
    assert.equal(auditAfter.summary.invalidConversationKeys, 0);
    assert.equal(auditAfter.summary.orphanStatuses, 0);
    assert.equal(auditAfter.summary.duplicateMediaFiles, 0);
    assert.equal(auditAfter.summary.missingMediaReferences, 1);
    evidence.checks.afterMigration = auditAfter.summary;

    const second = buildMigrationPlan(dataDir, { retentionDays: 30 });
    assert.equal(second.summary.changedFiles, 0);
    assert.equal(second.summary.leadMerges, 0);
    evidence.checks.idempotent = true;

    const port = await availablePort();
    running = await startServer(dataDir, port);
    assert.equal(await waitForHealth(`http://127.0.0.1:${port}`, running.child), true, JSON.stringify(running.output()));
    evidence.checks.strictBootValid = true;
    await stop(running.child);
    running = null;

    const tamperLine = JSON.stringify({ id: crypto.randomUUID(), whatsapp_digits: '5511777777777' }) + '\n';
    fs.appendFileSync(path.join(dataDir, 'admin', 'leads.jsonl'), tamperLine);
    const blockedPort = await availablePort();
    const blocked = await startServer(dataDir, blockedPort);
    const exitCode = await waitExit(blocked.child);
    const blockedOutput = blocked.output();
    assert.notEqual(exitCode, 0);
    assert.match(blockedOutput.stderr, /DATA_INTEGRITY_BOOT_FAILED/);
    evidence.checks.strictBootBlocksTampering = true;

    // Restore the post-migration checksum before rollback so rollback can validate it.
    fs.truncateSync(path.join(dataDir, 'admin', 'leads.jsonl'), fs.statSync(path.join(dataDir, 'admin', 'leads.jsonl')).size - Buffer.byteLength(tamperLine));
    // The truncation above uses a fixed UUID length; validate checksum and repair from planned output if needed.
    const leadManifest = applied.manifest.files.find((item) => item.tenantId === 'admin' && item.filename === 'leads.jsonl');
    const leadPath = path.join(dataDir, 'admin', 'leads.jsonl');
    if (fileSha256(leadPath) !== leadManifest.afterSha256) {
      const tenantPlan = plan.tenants.find((item) => item.tenantId === 'admin');
      fs.writeFileSync(leadPath, tenantPlan.outputFiles['leads.jsonl']);
    }

    rollbackMigration(applied.manifestPath, { confirm: 'ROLLBACK_DATA_INTEGRITY' });
    assert.equal(treeDigest(dataDir), beforeDigest);
    evidence.checks.rollbackExact = true;

    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  } finally {
    if (running) await stop(running.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
