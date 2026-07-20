'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerTenantPanelRoutes } = require('../src/routes/tenant/registerTenantPanelRoutes');

function handler(_req, res) {
  res.json({ ok: true });
}

function routePaths(app) {
  return app._router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`));
}

function buildServices(tenantId) {
  return {
    tenantId,
    authMiddleware: (_req, _res, next) => next(),
    projectRoot: process.cwd(),
    buildLeadsHandler: () => handler,
    buildUpdateLeadHandler: () => handler,
    buildMergeLeadHandler: () => handler,
    deleteLeadEverywhere: async () => ({ ok: true }),
    createManualLead: async () => ({ id: 'lead-1' }),
    getLeadItemsForRequest: () => ({ items: [] }),
    auditSecurityAction: () => {},
    toCSV: () => '',
    readCrmState: () => ({}),
    saveCrmStateAndQueueMessages: () => ({}),
    getTenantWA: () => ({
      getWhatsAppStatus: () => ({ ok: true }),
      initWhatsApp: async () => {},
      getLatestQr: () => null,
    }),
    summarizeLeadWhatsappStats: () => ({}),
    buildTenantInsights: () => ({ ok: true }),
    buildConversationsRoutes: () => {},
    listTags: () => [],
    upsertTag: () => ({ id: 'tag-1' }),
    deleteTag: () => {},
    removeTagFromAllLeads: () => {},
    setLeadTags: () => ({ leadId: 'lead-1', tagIds: [] }),
    buildBulkLeadTagsHandler: () => handler,
    getTemplate: () => ({ text: '' }),
    updateTemplateSafe: () => ({ text: '' }),
    listWebhooks: () => [],
    serializeWebhook: (value) => value,
    createWebhook: () => ({ id: 'webhook-1' }),
    updateWebhook: () => ({ ok: true }),
    deleteWebhook: () => ({ ok: true }),
  };
}

test('registrador tenant-aware cria a mesma superfície para todos os tenants sem cópia manual', () => {
  for (const tenantId of ['admin', 'panel', 'regina', 'portugal', 'felipe', 'ana']) {
    const app = express();
    registerTenantPanelRoutes(app, buildServices(tenantId));
    const paths = routePaths(app);
    assert.equal(paths.length, 25);
    assert.ok(paths.includes(`GET /${tenantId}`));
    assert.ok(paths.includes(`GET /api/${tenantId}/leads`));
    assert.ok(paths.includes(`PUT /api/${tenantId}/leads/:id`));
    assert.ok(paths.includes(`GET /api/${tenantId}/crm`));
    assert.ok(paths.includes(`POST /api/${tenantId}/whatsapp/init`));
    assert.ok(paths.includes(`GET /api/${tenantId}/webhooks`));
    assert.ok(paths.every((item) => !item.includes('/api/undefined/')));
  }
});
