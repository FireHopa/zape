'use strict';

/**
 * @param {import('express').Application} app
 * @param {{
 *  tenantId: string,
 *  authMiddleware: import('express').RequestHandler,
 *  listWebhooks: Function,
 *  serializeWebhook: Function,
 *  createWebhook: Function,
 *  updateWebhook: Function,
 *  deleteWebhook: Function
 * }} options
 */
function registerWebhookManagementRoutes(app, options) {
  const {
    tenantId,
    authMiddleware,
    listWebhooks,
    serializeWebhook,
    createWebhook,
    updateWebhook,
    deleteWebhook,
  } = options;
  const apiPrefix = `/api/${tenantId}`;

  app.get(`${apiPrefix}/webhooks`, authMiddleware, (req, res) => {
    const webhooks = listWebhooks(tenantId).map((webhook) => serializeWebhook(webhook, req));
    return res.json({ ok: true, webhooks });
  });

  app.post(`${apiPrefix}/webhooks`, authMiddleware, (req, res) => {
    const webhook = createWebhook(tenantId, { name: req.body && req.body.name });
    return res.json({ ok: true, ...serializeWebhook(webhook, req) });
  });

  app.put(`${apiPrefix}/webhooks/:id`, authMiddleware, (req, res) => {
    const out = updateWebhook(tenantId, req.params.id, req.body);
    if (!out.ok) return res.status(400).json(out);
    return res.json(out);
  });

  app.delete(`${apiPrefix}/webhooks/:id`, authMiddleware, (req, res) => {
    const out = deleteWebhook(tenantId, req.params.id);
    if (!out.ok) return res.status(400).json(out);
    return res.json({ ok: true });
  });
}

module.exports = { registerWebhookManagementRoutes };
