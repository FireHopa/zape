#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  createFixture,
  credentialsForTenants,
  buildEnv,
  freePort,
  startApplication,
  stopApplication,
  login,
  jsonRequest,
  startFakeMetaServer,
  makeTempRoot,
  sleep,
} = require('../tests/helpers/phase15Harness');
const { createDataManifest, validateDataIntegrityOnBoot, atomicWriteJson } = require('../src/dataIntegrity');

const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFile = outputArg ? path.resolve(outputArg.slice('--output='.length)) : '';
const ROOT = path.resolve(__dirname, '..');

async function waitJob(baseUrl, auth, jobId, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const out = await jsonRequest(baseUrl, `/api/wa-cloud/jobs/${jobId}`, { auth });
    if (out.status === 200) {
      const state = out.payload.job.state;
      if (['completed', 'completed_with_errors', 'failed', 'canceled', 'paused'].includes(state)) return out.payload.job;
    }
    await sleep(75);
  }
  throw new Error('Timeout aguardando recuperação do job.');
}

async function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    sleep(timeoutMs).then(() => null),
  ]);
}

(async () => {
  const root = makeTempRoot('zape-phase15-recovery-');
  const dataDir = path.join(root, 'data');
  createFixture(dataDir);
  const credentials = credentialsForTenants();
  const panelOnly = { panel: credentials.panel };
  const appPort = await freePort();
  const meta = await startFakeMetaServer();
  const { env, baseUrl } = buildEnv(root, appPort, panelOnly, {
    WA_CLOUD_ENABLED: '1',
    WA_CLOUD_FORCE_ENV: '1',
    WA_CLOUD_TOKEN: 'synthetic-recovery-token',
    WA_CLOUD_PHONE_NUMBER_ID: '1510',
    WA_CLOUD_WABA_ID: '2510',
    WA_CLOUD_GRAPH_VERSION: 'v25.0',
    WA_CLOUD_GRAPH_BASE_URL: meta.baseUrl,
    WA_CLOUD_CONNECTION_OWNER_TENANT: 'admin',
    WA_CLOUD_QUEUE_POLL_MS: '20',
    WA_CLOUD_QUEUE_MAX_ATTEMPTS: '3',
    WA_CLOUD_QUEUE_RETRY_BASE_MS: '20',
    WA_CLOUD_QUEUE_RETRY_MAX_MS: '100',
  });
  let app;
  const evidence = {
    phase: 15,
    suite: 'recovery',
    syntheticOnly: true,
    generatedAt: new Date().toISOString(),
    checks: {},
  };
  try {
    app = await startApplication(env, baseUrl);
    let auth = await login(baseUrl, 'panel', panelOnly);
    const contacts = Array.from({ length: 30 }, (_, index) => ({
      to: `55117${String(10000000 + index).slice(-8)}`,
    }));
    const created = await jsonRequest(baseUrl, '/api/wa-cloud/send-template-batch', {
      method: 'POST', mutating: true, auth,
      headers: { 'Idempotency-Key': 'phase15-recovery-job' },
      body: { templateName: 'recovery_template', contacts, throttleMs: 75 },
    });
    assert.equal(created.status, 202, created.text);
    const jobId = created.payload.job.id;
    const deadline = Date.now() + 10000;
    while (meta.state.requests.filter((request) => /\/messages$/.test(request.url)).length < 3 && Date.now() < deadline) {
      await sleep(50);
    }
    const beforeCrash = meta.state.requests.filter((request) => /\/messages$/.test(request.url)).length;
    assert.ok(beforeCrash >= 1);
    app.child.kill('SIGKILL');
    await waitForExit(app.child, 5000);

    app = await startApplication(env, baseUrl);
    auth = await login(baseUrl, 'panel', panelOnly);
    let recovered = await waitJob(baseUrl, auth, jobId, 15000);
    if (recovered.state === 'paused') {
      const resumed = await jsonRequest(baseUrl, `/api/wa-cloud/jobs/${jobId}/resume`, {
        method: 'POST', mutating: true, auth, body: {},
      });
      assert.equal(resumed.status, 200, resumed.text);
      recovered = await waitJob(baseUrl, auth, jobId, 30000);
    }
    assert.ok(['completed', 'completed_with_errors'].includes(recovered.state), JSON.stringify(recovered));
    assert.equal(recovered.progress.sent + recovered.progress.failed, 30);
    const recipientCounts = Array.from(meta.state.counts.values());
    assert.equal(recipientCounts.every((count) => count === 1), true, JSON.stringify(recipientCounts));
    evidence.checks.workerRestart = {
      beforeCrash,
      finalState: recovered.state,
      sent: recovered.progress.sent,
      failed: recovered.progress.failed,
      duplicateRecipients: recipientCounts.filter((count) => count > 1).length,
    };

    await stopApplication(app.child);
    app = null;

    const unavailablePort = await freePort();
    const unavailableRoot = path.join(root, 'db-unavailable');
    fs.mkdirSync(unavailableRoot, { recursive: true });
    createFixture(path.join(unavailableRoot, 'data'));
    const unavailableCredentials = { admin: credentials.admin };
    const unavailable = buildEnv(unavailableRoot, unavailablePort, unavailableCredentials, {
      PERSISTENCE_MODE: 'database',
      DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/zape_phase15',
      DATABASE_SSL: 'disable',
      DATABASE_CONNECTION_TIMEOUT_MS: '750',
    });
    const dbChild = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: unavailable.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let dbStderr = '';
    dbChild.stderr.on('data', (chunk) => { dbStderr += chunk.toString(); });
    const dbExit = await waitForExit(dbChild, 8000);
    if (dbExit === null) dbChild.kill('SIGKILL');
    assert.notEqual(dbExit, 0);
    assert.match(dbStderr, /ECONNREFUSED|database|connect|Postgres/i);
    evidence.checks.databaseUnavailable = { failedClosed: true, exitCode: dbExit };

    for (const tenantId of ['admin', 'panel', 'regina', 'portugal', 'felipe', 'ana']) {
      const tenantDir = path.join(dataDir, tenantId);
      atomicWriteJson(path.join(tenantDir, '_data_manifest.json'), createDataManifest(tenantDir, tenantId));
    }
    fs.appendFileSync(path.join(dataDir, 'panel', 'leads.jsonl'), '{corrupted-json-line\n');
    let corruptionDetected = false;
    try {
      validateDataIntegrityOnBoot(dataDir, { strict: true });
    } catch (error) {
      corruptionDetected = error.code === 'DATA_INTEGRITY_BOOT_FAILED';
    }
    assert.equal(corruptionDetected, true);
    evidence.checks.corruptedData = { bootBlocked: true };

    const backupRoot = path.join(root, 'backup-source');
    const backupData = path.join(backupRoot, 'data');
    createFixture(backupData);
    const backupOut = path.join(backupRoot, 'backups');
    const backupRemote = path.join(backupRoot, 'remote');
    const backupEnv = {
      ...process.env,
      NODE_ENV: 'test',
      ZAPE_DATA_DIR: backupData,
      BACKUP_DIRECTORY: backupOut,
      BACKUP_REMOTE_DIRECTORY: backupRemote,
      CONFIG_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      PERSISTENCE_MODE: 'json',
    };
    const backup = spawnSync(process.execPath, ['scripts/full-backup.js'], {
      cwd: ROOT,
      env: backupEnv,
      encoding: 'utf8',
    });
    assert.equal(backup.status, 0, backup.stderr || backup.stdout);
    const backupResult = JSON.parse(backup.stdout);
    const restoreDir = path.join(backupRoot, 'restore');
    const restoreData = path.join(backupRoot, 'restored-data');
    const restore = spawnSync(process.execPath, [
      'scripts/full-restore.js',
      `--input=${backupResult.output}`,
      `--output-dir=${restoreDir}`,
      `--data-target=${restoreData}`,
      '--confirm=RESTORE_FULL_BACKUP',
    ], { cwd: ROOT, env: backupEnv, encoding: 'utf8' });
    assert.equal(restore.status, 0, restore.stderr || restore.stdout);
    assert.equal(fs.existsSync(path.join(restoreData, '_fixture_manifest.json')), true);
    evidence.checks.backupRestore = {
      encrypted: String(backupResult.output).endsWith('.enc'),
      remoteChecksumMatched: backupResult.archiveSha256 === backupResult.remoteSha256,
      restored: true,
    };
    evidence.checks.redis = {
      applicable: false,
      reason: 'A fila da Fase 10 usa persistência local equivalente; Redis não está ativo nesta arquitetura.',
    };

    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await stopApplication(app?.child);
    await meta.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
