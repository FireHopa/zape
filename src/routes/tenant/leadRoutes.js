'use strict';

/**
 * @param {import('express').Application} app
 * @param {{
 *  tenantId: string,
 *  authMiddleware: import('express').RequestHandler,
 *  buildLeadsHandler: Function,
 *  buildUpdateLeadHandler: Function,
 *  buildMergeLeadHandler: Function,
 *  deleteLeadEverywhere: Function,
 *  createManualLead: Function,
 *  respondLeadServiceError: Function,
 *  getLeadItemsForRequest: Function,
 *  auditSecurityAction: Function,
 *  toCSV: Function,
 *  leadPaginationFeatureGate?: import('express').RequestHandler
 * }} options
 */
function registerLeadRoutes(app, options) {
  const {
    tenantId,
    authMiddleware,
    buildLeadsHandler,
    buildUpdateLeadHandler,
    buildMergeLeadHandler,
    deleteLeadEverywhere,
    createManualLead,
    respondLeadServiceError,
    getLeadItemsForRequest,
    auditSecurityAction,
    toCSV,
    leadPaginationFeatureGate,
  } = options;
  const apiPrefix = `/api/${tenantId}`;

  const readMiddleware = leadPaginationFeatureGate
    ? [authMiddleware, leadPaginationFeatureGate]
    : [authMiddleware];
  app.get(`${apiPrefix}/leads`, ...readMiddleware, buildLeadsHandler({ tenantId }));
  app.put(`${apiPrefix}/leads/:id`, authMiddleware, buildUpdateLeadHandler(tenantId));
  app.post(`${apiPrefix}/leads/:id/merge`, authMiddleware, buildMergeLeadHandler(tenantId));

  app.delete(`${apiPrefix}/leads/:id`, authMiddleware, async (req, res) => {
    const out = await deleteLeadEverywhere(tenantId, req.params.id, req);
    if (!out.ok) return res.status(404).json(out);
    return res.json(out);
  });

  app.post(`${apiPrefix}/leads/manual`, authMiddleware, async (req, res) => {
    try {
      const lead = await createManualLead(tenantId, req.body || {});
      return res.json({ ok: true, lead });
    } catch (error) {
      if (typeof respondLeadServiceError === 'function') return respondLeadServiceError(res, error);
      return res
        .status(error?.statusCode || 400)
        .json({ ok: false, code: error?.code, error: error.message });
    }
  });

  app.get(`/${tenantId}/leads.csv`, ...readMiddleware, (req, res) => {
    const payload = getLeadItemsForRequest(tenantId, req, { paginate: false });
    auditSecurityAction(req, 'lead.export', 'leads.csv', 'success', {
      tenantId,
      total: payload.items.length,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads_${tenantId}.csv"`);
    return res.send(toCSV(payload.items));
  });
}

module.exports = { registerLeadRoutes };
