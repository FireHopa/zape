'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createFixture,
  credentialsForTenants,
  buildEnv,
  freePort,
  startApplication,
  stopApplication,
  login,
  jsonRequest,
  makeTempRoot,
} = require('./helpers/phase15Harness');

function sign(secret, timestamp, eventId, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${eventId}.`)
    .update(rawBody)
    .digest('hex')}`;
}

test('Fase 15: concorrência não duplica lead, webhook nem sobrescreve edição', async () => {
  const root = makeTempRoot('zape-phase15-concurrency-');
  createFixture(path.join(root, 'data'));
  const credentials = credentialsForTenants();
  const panelOnly = { panel: credentials.panel };
  const port = await freePort();
  const { env, baseUrl } = buildEnv(root, port, panelOnly, {
    CUSTOM_WEBHOOK_REQUIRE_SIGNATURE: '1',
    CUSTOM_WEBHOOK_RATE_LIMIT_MAX: '1000',
  });
  let app;
  try {
    app = await startApplication(env, baseUrl);
    const auth = await login(baseUrl, 'panel', panelOnly);

    const duplicatePayload = {
      nome: 'Lead Concorrente',
      email: 'concorrente@example.invalid',
      whatsapp: '+55 11 96666-1515',
      source: 'phase15_concurrency',
    };
    const creates = await Promise.all(Array.from({ length: 8 }, () => jsonRequest(baseUrl, '/api/panel/leads/manual', {
      method: 'POST', mutating: true, auth, body: duplicatePayload,
    })));
    const createStatuses = creates.map((item) => item.status).sort();
    assert.equal(createStatuses.filter((status) => status === 200).length, 1, JSON.stringify(createStatuses));
    assert.equal(createStatuses.filter((status) => status === 409).length, 7, JSON.stringify(createStatuses));
    const uniqueList = await jsonRequest(baseUrl, '/api/panel/leads?q=concorrente@example.invalid&pageSize=100', { auth });
    assert.equal(uniqueList.payload.total, 1);

    const current = uniqueList.payload.items[0];
    const updateBase = {
      _version: current._version,
      email: current.email,
      whatsapp: current.whatsapp_raw,
      empresa: current.empresa,
      jaAnuncia: current.jaAnuncia,
      website: current.website,
    };
    const updates = await Promise.all([
      jsonRequest(baseUrl, `/api/panel/leads/${encodeURIComponent(current.id)}`, {
        method: 'PUT', mutating: true, auth, body: { ...updateBase, nome: 'Edição A' },
      }),
      jsonRequest(baseUrl, `/api/panel/leads/${encodeURIComponent(current.id)}`, {
        method: 'PUT', mutating: true, auth, body: { ...updateBase, nome: 'Edição B' },
      }),
    ]);
    const updateStatuses = updates.map((item) => item.status).sort();
    assert.deepEqual(updateStatuses, [200, 409]);

    const webhookCreate = await jsonRequest(baseUrl, '/api/panel/webhooks', {
      method: 'POST', mutating: true, auth, body: { name: 'Concorrência Fase 15' },
    });
    assert.equal(webhookCreate.status, 200, webhookCreate.text);
    const webhookPath = new URL(webhookCreate.payload.url).pathname;
    const secret = webhookPath.split('/').filter(Boolean).pop();
    const rawBody = Buffer.from(JSON.stringify({
      nome: 'Webhook Concorrente',
      email: 'webhook-concorrente@example.invalid',
      whatsapp: '+55 11 95555-1515',
    }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const eventId = `phase15-concurrent-webhook-${crypto.randomBytes(8).toString('hex')}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Zape-Timestamp': timestamp,
      'X-Zape-Event-Id': eventId,
      'X-Zape-Signature': sign(secret, timestamp, eventId, rawBody),
    };
    const webhooks = await Promise.all(Array.from({ length: 10 }, () => jsonRequest(baseUrl, webhookPath, {
      method: 'POST', headers, body: rawBody, rawBody: true,
    })));
    assert.equal(webhooks.every((item) => [200, 202].includes(item.status)), true, JSON.stringify(webhooks.map((item) => item.status)));
    assert.equal(webhooks.filter((item) => item.status === 200).length, 1);
    const settledWebhook = await jsonRequest(baseUrl, webhookPath, {
      method: 'POST', headers, body: rawBody, rawBody: true,
    });
    assert.equal(settledWebhook.status, 200, settledWebhook.text);
    assert.ok(settledWebhook.payload.leadId);
    const webhookLeads = await jsonRequest(baseUrl, '/api/panel/leads?q=webhook-concorrente@example.invalid&pageSize=100', { auth });
    assert.equal(webhookLeads.payload.total, 1);
  } finally {
    await stopApplication(app?.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
