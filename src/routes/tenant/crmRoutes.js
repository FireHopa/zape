'use strict';

/**
 * @param {import('express').Application} app
 * @param {{
 *  tenantId: string,
 *  authMiddleware: import('express').RequestHandler,
 *  readCrmState: Function,
 *  saveCrmStateAndQueueMessages: Function
 * }} options
 */
function registerCrmRoutes(app, options) {
  const { tenantId, authMiddleware, readCrmState, saveCrmStateAndQueueMessages } = options;
  const apiPrefix = `/api/${tenantId}`;

  app.get(`${apiPrefix}/crm`, authMiddleware, (_req, res) => {
    return res.json({ ok: true, state: readCrmState(tenantId) });
  });

  app.put(`${apiPrefix}/crm`, authMiddleware, (req, res) => {
    const state = saveCrmStateAndQueueMessages(tenantId, req.body && (req.body.state || req.body));
    return res.json({ ok: true, state });
  });
}

module.exports = { registerCrmRoutes };
