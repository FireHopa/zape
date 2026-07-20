'use strict';

function registerAdminDeploymentRoutes(app, options) {
  const {
    adminAuth,
    requireRole,
    requirePermission,
    roles,
    permissions,
    releaseMetadata,
    featureSnapshot,
    auditSecurityAction,
  } = options;

  app.get(
    '/api/admin/deployment',
    adminAuth,
    requireRole(roles.SUPER_ADMIN),
    requirePermission(permissions.MONITORING_READ),
    (req, res) => {
      const release = releaseMetadata();
      const features = featureSnapshot();
      auditSecurityAction(req, 'deployment.view', 'release', 'success', {
        releaseId: release.releaseId,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, release, features });
    }
  );
}

module.exports = { registerAdminDeploymentRoutes };
