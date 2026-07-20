#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFile = outputArg ? path.resolve(outputArg.slice('--output='.length)) : '';

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

async function waitForHealth(baseUrl, child, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) return false;
    try { if ((await fetch(`${baseUrl}/health`)).status === 200) return true; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function cookiesFrom(response) {
  return response.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
}

function cookieValue(cookieHeader, name) {
  const part = cookieHeader.split(/;\s*/).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function startFakeMeta(port) {
  let messageCounter = 0;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const bodyBuffer = await readRequestBody(req);
    const bodyText = bodyBuffer.toString('utf8');
    let body = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch {}
    requests.push({ method: req.method, path: req.url, body });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/v25.0/debug_token') {
      return json(res, 200, { data: { is_valid: true, expires_at: 9999999999, granular_scopes: [
        { scope: 'whatsapp_business_management', target_ids: ['200'] },
        { scope: 'whatsapp_business_messaging', target_ids: ['200'] },
      ] } });
    }
    if (req.method === 'GET' && url.pathname === '/v25.0/100') {
      return json(res, 200, {
        id: '100', display_phone_number: '+55 11 99999-9999', verified_name: 'Empresa Sintética',
        quality_rating: 'GREEN', platform_type: 'CLOUD_API', code_verification_status: 'VERIFIED',
      });
    }
    if (req.method === 'GET' && url.pathname === '/v25.0/200') {
      return json(res, 200, { id: '200', name: 'WABA Sintético', currency: 'BRL', timezone_id: '1' });
    }
    if (req.method === 'GET' && url.pathname === '/v25.0/200/subscribed_apps') {
      return json(res, 200, { data: [{ id: '300' }] });
    }
    if (req.method === 'GET' && url.pathname === '/v25.0/200/message_templates') {
      return json(res, 200, { data: [{ id: 'tpl_1', name: 'template_teste', status: 'APPROVED' }] });
    }
    if (req.method === 'POST' && url.pathname === '/v25.0/100/messages') {
      if (String(body?.to || '').endsWith('0010')) {
        return json(res, 400, { error: { code: 133010, message: 'Account not registered', type: 'OAuthException', fbtrace_id: 'synthetic-trace' } });
      }
      messageCounter += 1;
      return json(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: body?.to, wa_id: body?.to }], messages: [{ id: `wamid.synthetic.${messageCounter}` }] });
    }
    return json(res, 404, { error: { code: 100, message: 'Synthetic endpoint not found' } });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, requests };
}

async function login(baseUrl, tenant, username, password) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ tenant, username, password }),
  });
  assert.equal(response.status, 200, await response.text());
  const cookie = cookiesFrom(response);
  const csrf = cookieValue(cookie, 'zape_csrf');
  assert.ok(cookie);
  assert.ok(csrf);
  return { cookie, csrf };
}

function metaSignature(secret, raw) {
  return `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
}

async function postMetaWebhook(baseUrl, appSecret, body) {
  const raw = Buffer.from(JSON.stringify(body));
  return fetch(`${baseUrl}/webhooks/wa-cloud`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': metaSignature(appSecret, raw) },
    body: raw,
  });
}

function statusWebhook({ status, messageId, recipientId = '5511999999999', phoneNumberId = '100', wabaId = '200' }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: wabaId, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '+5511999999999', phone_number_id: phoneNumberId },
      statuses: [{ id: messageId, recipient_id: recipientId, status, timestamp: '1720000000', conversation: { id: 'conv.synthetic.1' } }],
    } }] }],
  };
}

function inboundWebhook({ messageId, from = '5511999999999', contextMessageId = '', phoneNumberId = '100', wabaId = '200' }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: wabaId, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '+5511999999999', phone_number_id: phoneNumberId },
      messages: [{ id: messageId, from, timestamp: '1720000100', type: 'text', text: { body: 'Resposta sintética' }, ...(contextMessageId ? { context: { id: contextMessageId } } : {}) }],
    } }] }],
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-phase9-smoke-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const appPort = await availablePort();
  const metaPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const metaBaseUrl = `http://127.0.0.1:${metaPort}`;
  const adminUser = `admin_${crypto.randomBytes(5).toString('hex')}`;
  const panelUser = `panel_${crypto.randomBytes(5).toString('hex')}`;
  const adminPass = crypto.randomBytes(32).toString('base64url');
  const panelPass = crypto.randomBytes(32).toString('base64url');
  const appSecret = crypto.randomBytes(32).toString('hex');
  const verifyToken = crypto.randomBytes(32).toString('base64url');
  const fakeMeta = await startFakeMeta(metaPort);
  const env = {
    ...process.env,
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(appPort), PUBLIC_BASE_URL: baseUrl,
    ZAPE_DATA_DIR: dataDir,
    SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
    SESSION_STORE_FILE: path.join(root, 'sessions.json'),
    SECURITY_AUDIT_FILE: path.join(root, 'security.jsonl'),
    CONFIG_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    ADMIN_ENABLED: '1', ADMIN_USER: adminUser, ADMIN_PASS: adminPass,
    PANEL_ENABLED: '1', PANEL_USER: panelUser, PANEL_PASS: panelPass,
    REGINA_ENABLED: '0', PORTUGAL_ENABLED: '0', FELIPE_ENABLED: '0', ANA_ENABLED: '0',
    WEBJS_ENABLED: '0', WEBJS_AUTO_START: '0', CRM_INTEGRATION_ENABLED: '0',
    PUBLIC_LEAD_FORM_ENABLED: '0', ACTIVECAMPAIGN_WEBHOOK_ENABLED: '0', ENABLE_DEBUG_ACTIVE: '0',
    DATA_INTEGRITY_VALIDATE_ON_BOOT: '0',
    WA_CLOUD_ENABLED: '1', WA_CLOUD_FORCE_ENV: '1', WA_CLOUD_TOKEN: 'synthetic-cloud-token',
    WA_CLOUD_PHONE_NUMBER_ID: '100', WA_CLOUD_WABA_ID: '200', WA_CLOUD_GRAPH_VERSION: 'v25.0',
    WA_CLOUD_GRAPH_BASE_URL: metaBaseUrl, WA_CLOUD_WEBHOOK_VERIFY_TOKEN: verifyToken,
    WA_CLOUD_CONNECTION_OWNER_TENANT: 'admin',
    WA_EMBEDDED_APP_ID: '300', WA_EMBEDDED_APP_SECRET: appSecret, WA_EMBEDDED_CONFIG_ID: '400',
  };

  let stdout = ''; let stderr = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const evidence = { phase: 9, syntheticOnly: true, generatedAt: new Date().toISOString(), checks: {} };

  try {
    assert.equal(await waitForHealth(baseUrl, child), true, JSON.stringify({ stdout, stderr }));
    const admin = await login(baseUrl, 'admin', adminUser, adminPass);
    const panel = await login(baseUrl, 'panel', panelUser, panelPass);

    const healthResponse = await fetch(`${baseUrl}/api/wa-cloud/health`, { headers: { Cookie: admin.cookie } });
    const health = await healthResponse.json();
    assert.equal(healthResponse.status, 200, JSON.stringify(health));
    assert.equal(health.ok, true);
    assert.equal(health.status, 'healthy');
    assert.ok(health.connection.connectionId);
    assert.equal(JSON.stringify(health).includes('synthetic-cloud-token'), false);
    const panelHealth = await fetch(`${baseUrl}/api/wa-cloud/health`, { headers: { Cookie: panel.cookie } });
    assert.equal(panelHealth.status, 403);
    evidence.checks.health = { admin: 200, panel: 403, status: health.status, connectionIdPresent: true };

    const sendResponse = await fetch(`${baseUrl}/api/wa-cloud/send-template-batch`, {
      method: 'POST',
      headers: { Cookie: panel.cookie, Origin: baseUrl, 'Content-Type': 'application/json', 'X-Zape-CSRF-Token': panel.csrf },
      body: JSON.stringify({ templateName: 'template_teste', languageCode: 'pt_BR', campaignName: 'Campanha painel', throttleMs: 0, contacts: [{ to: '5511999999999', nome: 'Contato sintético' }] }),
    });
    const send = await sendResponse.json();
    assert.equal(sendResponse.status, 202, JSON.stringify(send));
    assert.ok(send.job && send.job.id);
    const jobDeadline = Date.now() + 10000;
    let sendJob = send.job;
    while (!['completed', 'completed_with_errors', 'failed', 'canceled'].includes(sendJob.state) && Date.now() < jobDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const jobResponse = await fetch(`${baseUrl}/api/wa-cloud/jobs/${send.job.id}`, { headers: { Cookie: panel.cookie } });
      const jobBody = await jobResponse.json();
      assert.equal(jobResponse.status, 200, JSON.stringify(jobBody));
      sendJob = jobBody.job;
    }
    assert.equal(sendJob.state, 'completed');
    assert.equal(sendJob.progress.sent, 1);

    const panelInitial = await fetch(`${baseUrl}/api/wa-cloud/statuses`, { headers: { Cookie: panel.cookie } }).then((res) => res.json());
    const messageId = panelInitial.items[0].messageId;
    assert.equal(messageId, 'wamid.synthetic.1');
    const adminInitial = await fetch(`${baseUrl}/api/wa-cloud/statuses`, { headers: { Cookie: admin.cookie } }).then((res) => res.json());
    assert.equal(panelInitial.total, 1);
    assert.equal(panelInitial.items[0].status, 'submitted');
    assert.equal(adminInitial.total, 0);
    assert.equal(panelInitial.items[0].messageId, messageId);
    assert.ok(panelInitial.items[0].dispatchId);
    assert.ok(panelInitial.items[0].connectionId);
    evidence.checks.tenantIsolation = { panelStatuses: 1, adminStatuses: 0 };

    const deliveredPayload = statusWebhook({ status: 'delivered', messageId });
    const delivered = await postMetaWebhook(baseUrl, appSecret, deliveredPayload);
    assert.equal(delivered.status, 200, await delivered.text());
    const repeated = await postMetaWebhook(baseUrl, appSecret, deliveredPayload);
    assert.equal(repeated.status, 200);

    const lateSent = await postMetaWebhook(baseUrl, appSecret, statusWebhook({ status: 'sent', messageId }));
    assert.equal(lateSent.status, 200);
    let panelStatuses = await fetch(`${baseUrl}/api/wa-cloud/statuses`, { headers: { Cookie: panel.cookie } }).then((res) => res.json());
    assert.equal(panelStatuses.items[0].status, 'delivered');
    assert.deepEqual(panelStatuses.items[0].statusHistory.map((row) => row.state), ['queued', 'submitted', 'delivered']);
    const deliveredJob = await fetch(`${baseUrl}/api/wa-cloud/jobs/${send.job.id}`, { headers: { Cookie: panel.cookie } }).then((res) => res.json()).then((body) => body.job);
    assert.equal(deliveredJob.progress.delivered, 1);
    evidence.checks.statusOrder = { final: 'delivered', history: panelStatuses.items[0].statusHistory.map((row) => row.state), duplicateIgnored: true, jobDelivered: deliveredJob.progress.delivered };

    const reply = await postMetaWebhook(baseUrl, appSecret, inboundWebhook({ messageId: 'wamid.in.1', contextMessageId: messageId }));
    assert.equal(reply.status, 200);
    panelStatuses = await fetch(`${baseUrl}/api/wa-cloud/statuses`, { headers: { Cookie: panel.cookie } }).then((res) => res.json());
    assert.equal(panelStatuses.items[0].status, 'replied');
    assert.equal(panelStatuses.items[0].campaignId, send.job.campaignId);
    const repliedJob = await fetch(`${baseUrl}/api/wa-cloud/jobs/${send.job.id}`, { headers: { Cookie: panel.cookie } }).then((res) => res.json()).then((body) => body.job);
    assert.equal(repliedJob.progress.responded, 1);
    evidence.checks.replyCorrelation = { status: 'replied', campaignMatched: true, method: 'context.id', jobResponded: repliedJob.progress.responded };

    const unmatched = await postMetaWebhook(baseUrl, appSecret, inboundWebhook({ messageId: 'wamid.in.2', contextMessageId: '' }));
    assert.equal(unmatched.status, 200);
    panelStatuses = await fetch(`${baseUrl}/api/wa-cloud/statuses`, { headers: { Cookie: panel.cookie } }).then((res) => res.json());
    assert.equal(panelStatuses.items[0].status, 'replied');
    const storeFile = path.join(dataDir, 'wa_cloud_dispatches.json');
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    const unmatchedRows = store.inboundEvents.filter((row) => row.matchMethod === 'unmatched');
    assert.equal(unmatchedRows.length, 1);
    assert.equal(unmatchedRows[0].matchedEventId, null);
    evidence.checks.unmatchedReply = { recorded: true, incorrectlyAttributed: false };

    const crossConnection = await postMetaWebhook(baseUrl, appSecret, statusWebhook({ status: 'read', messageId, phoneNumberId: '999' }));
    assert.equal(crossConnection.status, 403);
    evidence.checks.connectionMismatch = 403;

    const errorResponse = await fetch(`${baseUrl}/api/wa-cloud/send-template-batch`, {
      method: 'POST',
      headers: { Cookie: panel.cookie, Origin: baseUrl, 'Content-Type': 'application/json', 'X-Zape-CSRF-Token': panel.csrf },
      body: JSON.stringify({ templateName: 'template_teste', campaignName: 'Erro 133010', throttleMs: 0, contacts: [{ to: '5511999990010' }] }),
    });
    const errorBody = await errorResponse.json();
    assert.equal(errorResponse.status, 202);
    let errorJob = errorBody.job;
    const errorDeadline = Date.now() + 10000;
    while (!['completed', 'completed_with_errors', 'failed', 'canceled'].includes(errorJob.state) && Date.now() < errorDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      errorJob = await fetch(`${baseUrl}/api/wa-cloud/jobs/${errorBody.job.id}`, { headers: { Cookie: panel.cookie } }).then((res) => res.json()).then((body) => body.job);
    }
    assert.equal(errorJob.state, 'completed_with_errors');
    assert.equal(errorJob.progress.failed, 1);
    const errorStatuses = await fetch(`${baseUrl}/api/wa-cloud/statuses`, { headers: { Cookie: panel.cookie } }).then((res) => res.json());
    const errorEvent = errorStatuses.items.find((item) => item.campaignId === errorBody.job.campaignId);
    assert.ok(errorEvent);
    assert.equal(errorEvent.errorInfo.code, 133010);
    assert.match(errorEvent.errorInfo.action, /Registre o número|refaça o vínculo/i);
    evidence.checks.error133010 = { mapped: true, code: 133010, retryable: errorEvent.errorInfo.retryable };

    const auditText = fs.readFileSync(path.join(root, 'security.jsonl'), 'utf8');
    assert.match(auditText, /cloud_connection\.health/);
    assert.match(auditText, /cloud_campaign\.create/);
    assert.equal(auditText.includes('synthetic-cloud-token'), false);
    evidence.checks.audit = { health: true, campaignCreate: true, tokenLeaked: false };
    evidence.checks.fakeMetaRequests = fakeMeta.requests.length;

    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    console.error(error?.stack || error);
    console.error({ stdout, stderr });
    process.exitCode = 1;
  } finally {
    await stop(child);
    await new Promise((resolve) => fakeMeta.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
