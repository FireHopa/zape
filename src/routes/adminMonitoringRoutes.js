'use strict';

/**
 * @param {import('express').Application} app
 * @param {any} options
 */
function registerAdminMonitoringRoutes(app, options) {
  const {
    adminAuth,
    requireRole,
    requirePermission,
    roles,
    permissions,
    collectSystemSnapshot,
    databaseRuntime,
    operationalWhatsAppStatus,
    operationalCloudStatus,
    metrics,
    alertManager,
    auditSecurityAction,
  } = options;
  const access = [adminAuth, requireRole(roles.SUPER_ADMIN), requirePermission(permissions.MONITORING_READ)];

  app.get('/api/admin/monitoring', ...access, async (req, res) => {
    const snapshot = await collectSystemSnapshot({
      databaseHealth: () => databaseRuntime.health(),
      whatsappStatus: operationalWhatsAppStatus,
      cloudStatus: operationalCloudStatus,
      metrics,
    });
    metrics.set('zape_disk_used_percent', {}, snapshot.disk.usedPercent);
    metrics.set('zape_queue_pending', {}, snapshot.queue.pending);
    metrics.set('zape_queue_failed', {}, snapshot.queue.failed);
    auditSecurityAction(req, 'monitoring.read', 'system', 'success');
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, snapshot, alerts: alertManager.list(), metrics: metrics.snapshot() });
  });

  app.get('/api/admin/metrics', ...access, (req, res) => {
    auditSecurityAction(req, 'metrics.read', 'system', 'success');
    res.setHeader('Cache-Control', 'no-store');
    return res.type('text/plain; version=0.0.4').send(metrics.prometheus());
  });
}

module.exports = { registerAdminMonitoringRoutes };
