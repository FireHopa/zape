'use strict';

/**
 * @param {import('express').Application} app
 * @param {any} options
 */
function registerBusinessRoutes(app, options) {
  const {
    anyTenantAuth,
    adminAuth,
    requirePermission,
    permissions,
    tenantAdmin,
    readBusinessOwner,
    writeBusinessOwner,
    auditSecurityAction,
  } = options;

  app.get('/api/business', anyTenantAuth, requirePermission(permissions.BUSINESS_READ), (_req, res) => {
    return res.json({ ok: true, owner: readBusinessOwner(tenantAdmin) });
  });

  app.put('/api/business', adminAuth, requirePermission(permissions.BUSINESS_WRITE), (req, res) => {
    const data = req.body && req.body.owner ? req.body.owner : req.body;
    const owner = writeBusinessOwner(tenantAdmin, data);
    auditSecurityAction(req, 'business_owner.update', 'business_owner', 'success');
    return res.json({ ok: true, owner });
  });
}

module.exports = { registerBusinessRoutes };
