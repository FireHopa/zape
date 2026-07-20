'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  TENANTS,
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

function customSignature(secret, timestamp, eventId, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret)
    .update(Buffer.concat([
      Buffer.from(String(timestamp)),
      Buffer.from('.'),
      Buffer.from(eventId),
      Buffer.from('.'),
      rawBody,
    ]))
    .digest('hex')}`;
}

test('Fase 15: API completa, isolamento, webhooks, CRM, conversas e logout', async () => {
  const root = makeTempRoot('zape-phase15-api-');
  const dataDir = path.join(root, 'data');
  createFixture(dataDir);
  const credentials = credentialsForTenants();
  const port = await freePort();
  const { env, baseUrl } = buildEnv(root, port, credentials, {
    CUSTOM_WEBHOOK_REQUIRE_SIGNATURE: '1',
    CUSTOM_WEBHOOK_RATE_LIMIT_MAX: '1000',
    PUBLIC_ENDPOINT_RATE_LIMIT_MAX: '1000',
  });
  let app;
  try {
    app = await startApplication(env, baseUrl);
    const auth = {};
    for (const tenantId of TENANTS) auth[tenantId] = await login(baseUrl, tenantId, credentials);

    for (const tenantId of TENANTS) {
      const endpoints = [
        `/${tenantId}`,
        `/api/${tenantId}/leads?page=1&pageSize=10`,
        `/api/${tenantId}/tags`,
        `/api/${tenantId}/crm`,
        `/api/${tenantId}/webhooks`,
        `/api/${tenantId}/whatsapp/status`,
        `/api/${tenantId}/conversations`,
      ];
      for (const endpoint of endpoints) {
        const out = await jsonRequest(baseUrl, endpoint, { auth: auth[tenantId] });
        assert.equal(out.status, 200, `${tenantId} ${endpoint}: ${out.text}`);
      }
    }

    const crossTenant = await jsonRequest(baseUrl, '/api/admin/leads', { auth: auth.panel });
    assert.ok([401, 403].includes(crossTenant.status));

    const created = {};
    for (let index = 0; index < TENANTS.length; index += 1) {
      const tenantId = TENANTS[index];
      const lead = await jsonRequest(baseUrl, `/api/${tenantId}/leads/manual`, {
        method: 'POST', mutating: true, auth: auth[tenantId],
        body: {
          nome: `Lead API ${tenantId}`,
          email: `phase15-api-${tenantId}@example.invalid`,
          whatsapp: `+55 11 98888${String(1000 + index).slice(-4)}`,
          source: 'phase15_api',
        },
      });
      assert.equal(lead.status, 200, lead.text);
      assert.equal(lead.payload.ok, true);
      created[tenantId] = lead.payload.lead;

      const tag = await jsonRequest(baseUrl, `/api/${tenantId}/tags`, {
        method: 'POST', mutating: true, auth: auth[tenantId],
        body: { name: `Fase 15 ${tenantId}`, color: '#336699' },
      });
      assert.equal(tag.status, 200, tag.text);
      const assigned = await jsonRequest(baseUrl, `/api/${tenantId}/leads/${encodeURIComponent(created[tenantId].id)}/tags`, {
        method: 'POST', mutating: true, auth: auth[tenantId],
        body: { tagIds: [tag.payload.item.id] },
      });
      assert.equal(assigned.status, 200, assigned.text);

      const crm = await jsonRequest(baseUrl, `/api/${tenantId}/crm`, { auth: auth[tenantId] });
      assert.equal(crm.status, 200, crm.text);
      const crmSaved = await jsonRequest(baseUrl, `/api/${tenantId}/crm`, {
        method: 'PUT', mutating: true, auth: auth[tenantId], body: crm.payload.state,
      });
      assert.equal(crmSaved.status, 200, crmSaved.text);
    }

    const panelLeads = await jsonRequest(baseUrl, '/api/panel/leads?page=1&pageSize=100', { auth: auth.panel });
    const adminLeads = await jsonRequest(baseUrl, '/api/admin/leads?page=1&pageSize=100', { auth: auth.admin });
    assert.ok(panelLeads.payload.items.some((lead) => lead.id === created.panel.id));
    assert.equal(panelLeads.payload.items.some((lead) => lead.id === created.admin.id), false);
    assert.ok(adminLeads.payload.items.some((lead) => lead.id === created.admin.id));
    assert.equal(adminLeads.payload.items.some((lead) => lead.id === created.panel.id), false);

    const webhookCreate = await jsonRequest(baseUrl, '/api/panel/webhooks', {
      method: 'POST', mutating: true, auth: auth.panel, body: { name: 'Webhook Fase 15' },
    });
    assert.equal(webhookCreate.status, 200, webhookCreate.text);
    const webhookUrl = new URL(webhookCreate.payload.url);
    const secret = webhookUrl.pathname.split('/').filter(Boolean).pop();
    assert.ok(secret && secret.length >= 32);
    const rawBody = Buffer.from(JSON.stringify({
      nome: 'Lead Webhook Fase 15',
      email: 'phase15-webhook@example.invalid',
      whatsapp: '+55 11 97777-1515',
    }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const eventId = `phase15:${crypto.randomBytes(8).toString('hex')}`;
    const signedHeaders = {
      'Content-Type': 'application/json',
      'X-Zape-Timestamp': timestamp,
      'X-Zape-Event-Id': eventId,
      'X-Zape-Signature': customSignature(secret, timestamp, eventId, rawBody),
    };
    const firstWebhook = await jsonRequest(baseUrl, webhookUrl.pathname, {
      method: 'POST', headers: signedHeaders, body: rawBody, rawBody: true,
    });
    assert.equal(firstWebhook.status, 200, firstWebhook.text);
    const repeatedWebhook = await jsonRequest(baseUrl, webhookUrl.pathname, {
      method: 'POST', headers: signedHeaders, body: rawBody, rawBody: true,
    });
    assert.equal(repeatedWebhook.status, 200, repeatedWebhook.text);
    assert.equal(repeatedWebhook.payload.leadId, firstWebhook.payload.leadId);

    const afterWebhook = await jsonRequest(baseUrl, '/api/panel/leads?q=phase15-webhook@example.invalid&pageSize=100', { auth: auth.panel });
    assert.equal(afterWebhook.payload.total, 1);

    const conversations = await jsonRequest(baseUrl, '/api/panel/conversations', { auth: auth.panel });
    const fixtureConversation = (conversations.payload.items || conversations.payload.contacts || []).find((item) =>
      String(item.nome || '').includes('Pessoa Teste')
    );
    assert.ok(fixtureConversation, JSON.stringify(conversations.payload));
    const messages = await jsonRequest(baseUrl, `/api/panel/conversations/${fixtureConversation.whatsapp_digits}/messages`, { auth: auth.panel });
    assert.equal(messages.status, 200, messages.text);
    assert.ok(Array.isArray(messages.payload.messages));

    const logout = await jsonRequest(baseUrl, '/auth/logout', {
      method: 'POST', mutating: true, auth: auth.panel, body: {},
    });
    assert.equal(logout.status, 200, logout.text);
    const replay = await jsonRequest(baseUrl, '/api/panel/leads', { auth: auth.panel });
    assert.equal(replay.status, 401);
  } finally {
    await stopApplication(app?.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
