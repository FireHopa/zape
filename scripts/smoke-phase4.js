#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFile = outputArg ? path.resolve(outputArg.slice('--output='.length)) : '';

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function lineCount(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).length;
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

async function waitForHealth(baseUrl, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Servidor encerrou antes do health check: ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Timeout aguardando health check.');
}

function customSignature(secret, timestamp, eventId, rawBody) {
  const signed = Buffer.concat([
    Buffer.from(timestamp), Buffer.from('.'), Buffer.from(eventId), Buffer.from('.'), rawBody,
  ]);
  return `sha256=${crypto.createHmac('sha256', secret).update(signed).digest('hex')}`;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

(async () => {
  const evidence = { phase: 4, syntheticOnly: true, checks: {}, generatedAt: new Date().toISOString() };
  let child = null;
  let stdout = '';
  let stderr = '';
  let webhookTokenForCheck = '';
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const fixture = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'create-sanitized-fixture.js'), `--output=${DATA_DIR}`], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);

    const port = await availablePort();
    const sessionSecret = randomSecret(48);
    const configKey = crypto.randomBytes(32).toString('base64');
    const adminPassword = randomSecret(24);
    const publicFormToken = randomSecret(32);
    const activeToken = randomSecret(32);
    const metaSecret = randomSecret(32);
    const verifyToken = randomSecret(24);

    process.env.ZAPE_DATA_DIR = DATA_DIR;
    process.env.CONFIG_ENCRYPTION_KEY = configKey;
    delete require.cache[require.resolve('../src/webhooksStore')];
    const { createWebhook } = require('../src/webhooksStore');
    const webhook = createWebhook('panel', { name: 'Webhook sintético', messages: [] });
    assert.ok(webhook.token.length >= 32);
    webhookTokenForCheck = webhook.token;

    const env = {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      TRUST_PROXY_HOPS: '1',
      INFRA_ALLOW_ROOT_PROCESS: '1',
      INFRA_ALLOW_HTTP_FOR_TESTS: '1',
      PORT: String(port),
      DEBUG: '1',
      ENABLE_DEBUG_ACTIVE: '1',
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      SESSION_SECRET: sessionSecret,
      SESSION_STORE_FILE: path.join(DATA_DIR, 'auth_sessions.json'),
      SECURITY_AUDIT_FILE: path.join(DATA_DIR, 'security_audit.jsonl'),
      CONFIG_ENCRYPTION_KEY: configKey,
      ZAPE_DATA_DIR: DATA_DIR,
      WEBHOOK_IDEMPOTENCY_FILE: path.join(DATA_DIR, 'webhook_idempotency.json'),
      ADMIN_ENABLED: '1',
      ADMIN_USER: 'admin_synthetic',
      ADMIN_PASS: adminPassword,
      ADMIN_ROLE: 'super_admin',
      PANEL_ENABLED: '0', REGINA_ENABLED: '0', PORTUGAL_ENABLED: '0', FELIPE_ENABLED: '0', ANA_ENABLED: '0',
      WEBJS_ENABLED: '0', WEBJS_AUTO_START: '0',
      CRM_INTEGRATION_ENABLED: '0',
      EXTERNAL_CRM_QUEUE_FILE: path.join(DATA_DIR, 'external_crm_queue.json'),
      PUBLIC_LEAD_FORM_ENABLED: '1',
      PUBLIC_LEAD_FORM_TOKEN: publicFormToken,
      ACTIVECAMPAIGN_WEBHOOK_ENABLED: '1',
      ACTIVECAMPAIGN_WEBHOOK_TOKEN: activeToken,
      CUSTOM_WEBHOOK_REQUIRE_SIGNATURE: '1',
      CUSTOM_WEBHOOK_CLOCK_TOLERANCE_SECONDS: '300',
      PUBLIC_FORM_BODY_LIMIT: '250kb',
      PUBLIC_WEBHOOK_BODY_LIMIT: '500kb',
      META_WEBHOOK_BODY_LIMIT: '1mb',
      PUBLIC_RATE_LIMIT_WINDOW_MS: '60000',
      PUBLIC_FORM_RATE_LIMIT_MAX: '2',
      ACTIVECAMPAIGN_RATE_LIMIT_MAX: '20',
      CUSTOM_WEBHOOK_RATE_LIMIT_MAX: '20',
      META_WEBHOOK_RATE_LIMIT_MAX: '20',
      PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS: '0',
      WA_CLOUD_ENABLED: '0',
      WA_EMBEDDED_APP_SECRET: metaSecret,
      WA_CLOUD_WEBHOOK_VERIFY_TOKEN: verifyToken,
    };

    child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child);
    evidence.checks.health = 200;

    const debugResponse = await fetch(`${baseUrl}/debug/active`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(debugResponse.status, 404);
    evidence.checks.debugRouteProduction = 404;

    const verifyChallenge = `challenge_${crypto.randomBytes(8).toString('hex')}`;
    const verifyOk = await fetch(`${baseUrl}/webhooks/wa-cloud?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${encodeURIComponent(verifyChallenge)}`);
    assert.equal(verifyOk.status, 200);
    assert.equal(await verifyOk.text(), verifyChallenge);
    const verifyDenied = await fetch(`${baseUrl}/webhooks/wa-cloud?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(randomSecret(24))}&hub.challenge=x`);
    assert.equal(verifyDenied.status, 403);
    evidence.checks.metaVerificationGet = { valid: 200, invalid: 403 };

    const metaBody = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { metadata: { phone_number_id: '100000000000001' }, statuses: [{ id: 'wamid.synthetic.1', recipient_id: '5511999999999', status: 'delivered' }] } }] }],
    };
    const metaRaw = Buffer.from(JSON.stringify(metaBody));
    const missingMeta = await fetch(`${baseUrl}/webhooks/wa-cloud`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: metaRaw,
    });
    assert.equal(missingMeta.status, 401);
    evidence.checks.metaMissingSignature = 401;

    const invalidMeta = await fetch(`${baseUrl}/webhooks/wa-cloud`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` }, body: metaRaw,
    });
    assert.equal(invalidMeta.status, 401);
    evidence.checks.metaInvalidSignature = 401;

    const malformedMetaRaw = Buffer.from('{');
    const malformedMetaSignature = `sha256=${crypto.createHmac('sha256', metaSecret).update(malformedMetaRaw).digest('hex')}`;
    const malformedMeta = await fetch(`${baseUrl}/webhooks/wa-cloud`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': malformedMetaSignature }, body: malformedMetaRaw,
    });
    assert.equal(malformedMeta.status, 400);
    evidence.checks.metaMalformedPayload = 400;

    const metaSignature = `sha256=${crypto.createHmac('sha256', metaSecret).update(metaRaw).digest('hex')}`;
    const validMeta = await fetch(`${baseUrl}/webhooks/wa-cloud`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': metaSignature }, body: metaRaw,
    });
    assert.equal(validMeta.status, 200);
    const cloudStatusFile = path.join(DATA_DIR, 'wa_cloud_message_status.json');
    const statusAfterFirstMeta = fs.readFileSync(cloudStatusFile, 'utf8');
    const duplicateMeta = await fetch(`${baseUrl}/webhooks/wa-cloud`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': metaSignature }, body: metaRaw,
    });
    assert.equal(duplicateMeta.status, 200);
    assert.equal(fs.readFileSync(cloudStatusFile, 'utf8'), statusAfterFirstMeta);
    evidence.checks.metaValidAndDuplicate = { statuses: [200, 200], duplicateDidNotRewriteStatus: true };

    const leadsFile = path.join(DATA_DIR, 'panel', 'leads.jsonl');
    const adminLeadsFile = path.join(DATA_DIR, 'admin', 'leads.jsonl');
    const leadsBefore = lineCount(leadsFile);
    const adminBeforeCustom = lineCount(adminLeadsFile);
    const customBody = Buffer.from(JSON.stringify({ nome: 'Contato Sintético', whatsapp: '5511988887777', email: 'contato@example.invalid', tenantId: 'admin' }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const eventId = `evt_${crypto.randomBytes(8).toString('hex')}`;
    const missingCustom = await fetch(`${baseUrl}/webhooks/${webhook.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zape-Timestamp': timestamp, 'X-Zape-Event-Id': eventId }, body: customBody,
    });
    assert.equal(missingCustom.status, 401);
    assert.equal(lineCount(leadsFile), leadsBefore);
    evidence.checks.customMissingSignature = 401;

    const invalidCustom = await fetch(`${baseUrl}/webhooks/${webhook.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zape-Timestamp': timestamp, 'X-Zape-Event-Id': eventId, 'X-Zape-Signature': `sha256=${'0'.repeat(64)}` }, body: customBody,
    });
    assert.equal(invalidCustom.status, 401);
    assert.equal(lineCount(leadsFile), leadsBefore);
    evidence.checks.customInvalidSignature = 401;

    const signature = customSignature(webhook.token, timestamp, eventId, customBody);
    const validCustom = await fetch(`${baseUrl}/webhooks/${webhook.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zape-Timestamp': timestamp, 'X-Zape-Event-Id': eventId, 'X-Zape-Signature': signature }, body: customBody,
    });
    assert.equal(validCustom.status, 200);
    const validCustomBody = await validCustom.json();
    assert.equal(validCustomBody.ok, true);
    assert.equal(lineCount(leadsFile), leadsBefore + 1);

    const repeatedCustom = await fetch(`${baseUrl}/webhooks/${webhook.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zape-Timestamp': timestamp, 'X-Zape-Event-Id': eventId, 'X-Zape-Signature': signature }, body: customBody,
    });
    assert.equal(repeatedCustom.status, 200);
    const repeatedBody = await repeatedCustom.json();
    assert.equal(repeatedBody.duplicate, true);
    assert.equal(lineCount(leadsFile), leadsBefore + 1);
    assert.equal(lineCount(adminLeadsFile), adminBeforeCustom);

    const conflictingBody = Buffer.from(JSON.stringify({ nome: 'Outro Contato', whatsapp: '5511966665555' }));
    const conflictingSignature = customSignature(webhook.token, timestamp, eventId, conflictingBody);
    const conflictResponse = await fetch(`${baseUrl}/webhooks/${webhook.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zape-Timestamp': timestamp, 'X-Zape-Event-Id': eventId, 'X-Zape-Signature': conflictingSignature }, body: conflictingBody,
    });
    assert.equal(conflictResponse.status, 409);
    assert.equal(lineCount(leadsFile), leadsBefore + 1);
    evidence.checks.customIdempotency = { first: 200, duplicate: 200, conflict: 409, leadsAdded: 1, tenantOverrideIgnored: true };

    const formRaw = Buffer.from('nome=Contato+Form&whatsapp=5511955554444&tenantId=admin');
    const formEventId = `evt_${crypto.randomBytes(8).toString('hex')}`;
    const formTimestamp = String(Math.floor(Date.now() / 1000));
    const formSignature = customSignature(webhook.token, formTimestamp, formEventId, formRaw);
    const customForm = await fetch(`${baseUrl}/webhooks/${webhook.token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Zape-Timestamp': formTimestamp,
        'X-Zape-Event-Id': formEventId,
        'X-Zape-Signature': formSignature,
      },
      body: formRaw,
    });
    assert.equal(customForm.status, 200);
    assert.equal(lineCount(leadsFile), leadsBefore + 2);
    assert.equal(lineCount(adminLeadsFile), adminBeforeCustom);
    evidence.checks.customUrlencodedCompatibility = { status: 200, tenantOverrideIgnored: true };

    const invalidToken = await fetch(`${baseUrl}/webhooks/${randomSecret(32)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(invalidToken.status, 404);
    evidence.checks.invalidWebhookToken = 404;

    const wrongContent = await fetch(`${baseUrl}/webhooks/${webhook.token}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(wrongContent.status, 415);
    evidence.checks.unsupportedContentType = 415;

    const oversized = await fetch(`${baseUrl}/webhooks/${webhook.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(600 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    evidence.checks.payloadTooLarge = 413;

    const activeInvalidToken = await fetch(`${baseUrl}/webhooks/activecampaign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zape-Webhook-Token': randomSecret(32) }, body: '{}',
    });
    assert.equal(activeInvalidToken.status, 401);
    evidence.checks.activeInvalidToken = 401;

    const activePayload = { contact: { id: 'contact-synthetic', first_name: 'Active Teste', email: 'active@example.invalid', phone: '5511977776666', fields: {} }, seriesid: 'series-synthetic' };
    const adminBefore = lineCount(adminLeadsFile);
    const activeHeaders = { 'Content-Type': 'application/json', 'X-Zape-Webhook-Token': activeToken, 'X-Zape-Event-Id': 'active-event-synthetic' };
    const activeFirst = await fetch(`${baseUrl}/webhooks/activecampaign`, { method: 'POST', headers: activeHeaders, body: JSON.stringify(activePayload) });
    assert.equal(activeFirst.status, 200);
    const activeDuplicate = await fetch(`${baseUrl}/webhooks/activecampaign`, { method: 'POST', headers: activeHeaders, body: JSON.stringify(activePayload) });
    assert.equal(activeDuplicate.status, 200);
    assert.equal((await activeDuplicate.json()).duplicate, true);
    assert.equal(lineCount(adminLeadsFile), adminBefore + 1);
    evidence.checks.activeIdempotency = { first: 200, duplicate: 200, leadsAdded: 1 };

    const formHeaders = { 'Content-Type': 'application/json', 'X-Zape-Webhook-Token': publicFormToken };
    const formOne = await fetch(`${baseUrl}/api/leads`, { method: 'POST', headers: formHeaders, body: JSON.stringify({ nome: 'Teste', unexpected: true }) });
    const formTwo = await fetch(`${baseUrl}/api/leads`, { method: 'POST', headers: formHeaders, body: JSON.stringify({ nome: 'Teste', unexpected: true }) });
    const formThree = await fetch(`${baseUrl}/api/leads`, { method: 'POST', headers: formHeaders, body: JSON.stringify({ nome: 'Teste', unexpected: true }) });
    assert.equal(formOne.status, 400);
    assert.equal(formTwo.status, 400);
    assert.equal(formThree.status, 429);
    assert.ok(formThree.headers.get('retry-after'));
    evidence.checks.rateLimit = [400, 400, 429];

    const idempotency = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'webhook_idempotency.json'), 'utf8'));
    assert.ok(Array.isArray(idempotency.events));
    assert.equal(JSON.stringify(idempotency).includes(eventId), false);
    assert.equal(JSON.stringify(idempotency).includes(webhook.token), false);
    evidence.checks.idempotencyStoreRedacted = true;

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(`${stdout}
${stderr}`.includes(webhook.token), false);
    assert.match(stdout, /\/webhooks\/\[redacted\]/);
    evidence.checks.applicationLogRedaction = true;

    fs.writeFileSync(path.join(DATA_DIR, 'webhook_idempotency.json'), '{broken', 'utf8');
    const corruptEventId = `evt_${crypto.randomBytes(8).toString('hex')}`;
    const corruptTimestamp = String(Math.floor(Date.now() / 1000));
    const corruptBody = Buffer.from(JSON.stringify({ nome: 'Não deve entrar', whatsapp: '5511944443333' }));
    const corruptSignature = customSignature(webhook.token, corruptTimestamp, corruptEventId, corruptBody);
    const corruptStoreResponse = await fetch(`${baseUrl}/webhooks/${webhook.token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Zape-Timestamp': corruptTimestamp,
        'X-Zape-Event-Id': corruptEventId,
        'X-Zape-Signature': corruptSignature,
      },
      body: corruptBody,
    });
    assert.equal(corruptStoreResponse.status, 503);
    assert.equal(lineCount(leadsFile), leadsBefore + 2);
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    evidence.checks.idempotencyCorruptionFailsClosed = { status: 503, serverStillHealthy: true, leadsAdded: 0 };

    evidence.ok = true;
  } catch (error) {
    evidence.ok = false;
    evidence.error = { name: error.name, message: error.message };
    throw error;
  } finally {
    if (child) await stopChild(child);
    evidence.serverLog = {
      stdoutLines: stdout.split('\n').filter(Boolean).length,
      stderrLines: stderr.split('\n').filter(Boolean).length,
      containsAuthorization: /authorization|bearer\s+[a-z0-9._-]{20,}/i.test(`${stdout}\n${stderr}`),
      containsWebhookToken: Boolean(webhookTokenForCheck && `${stdout}
${stderr}`.includes(webhookTokenForCheck)),
    };
    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(JSON.stringify(evidence, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
