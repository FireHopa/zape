'use strict';

/**
 * @param {import('express').Application} app
 * @param {{
 *  tenantId: string,
 *  authMiddleware: import('express').RequestHandler,
 *  getTenantWA: Function,
 *  summarizeLeadWhatsappStats: Function,
 *  buildTenantInsights: Function,
 *  buildConversationsRoutes: Function,
 *  secureMediaFeatureGate?: import('express').RequestHandler
 * }} options
 */
function registerWhatsappWebRoutes(app, options) {
  const {
    tenantId,
    authMiddleware,
    getTenantWA,
    summarizeLeadWhatsappStats,
    buildTenantInsights,
    buildConversationsRoutes,
    secureMediaFeatureGate,
  } = options;
  const apiPrefix = `/api/${tenantId}`;

  app.get(`${apiPrefix}/whatsapp/status`, authMiddleware, (_req, res) => {
    return res.json(getTenantWA(tenantId).getWhatsAppStatus());
  });

  app.post(`${apiPrefix}/whatsapp/init`, authMiddleware, async (_req, res) => {
    try {
      await getTenantWA(tenantId).beginManualConnection();
      return res.json({ ok: true, ...getTenantWA(tenantId).getWhatsAppStatus() });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      return res.status(status >= 400 && status < 600 ? status : 500).json({
        ok: false,
        code: error?.code || 'WA_CONNECTION_FAILED',
        error: error?.message || String(error),
        details: error?.details || undefined,
        ...getTenantWA(tenantId).getWhatsAppStatus(),
      });
    }
  });

  app.delete(`${apiPrefix}/whatsapp/authentication`, authMiddleware, async (req, res) => {
    try {
      const status = await getTenantWA(tenantId).removeAuthentication({
        confirmation: req.body?.confirmation,
      });
      return res.json({ ok: true, ...status });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      return res.status(status >= 400 && status < 600 ? status : 500).json({
        ok: false,
        code: error?.code || 'WA_AUTHENTICATION_REMOVAL_FAILED',
        error: error?.message || String(error),
        ...getTenantWA(tenantId).getWhatsAppStatus(),
      });
    }
  });

  app.get(`${apiPrefix}/whatsapp/qr`, authMiddleware, (_req, res) => {
    return res.json({ ok: true, qr: getTenantWA(tenantId).getLatestQr() });
  });

  app.get(`${apiPrefix}/whatsapp/stats`, authMiddleware, (req, res) => {
    const notDeliveredAfterMin = Number(req.query.notDeliveredAfterMin || 30);
    return res.json({ ok: true, ...summarizeLeadWhatsappStats(tenantId, { notDeliveredAfterMin }) });
  });

  app.get(`${apiPrefix}/insights`, authMiddleware, (req, res) => {
    try {
      return res.json(buildTenantInsights(tenantId, req));
    } catch (error) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  buildConversationsRoutes({ tenantId, authMw: authMiddleware, prefix: apiPrefix, secureMediaFeatureGate });
}

module.exports = { registerWhatsappWebRoutes };
