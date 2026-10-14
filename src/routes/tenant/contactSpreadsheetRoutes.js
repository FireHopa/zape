'use strict';

const { contactSpreadsheet } = require('../../contactSpreadsheet');

/**
 * @param {import('express').Application} app
 * @param {any} options
 */
function registerContactSpreadsheetRoutes(app, { tenantId, authMiddleware, auditSecurityAction }) {
  const base = `/api/${tenantId}/contact-spreadsheet`;
  app.get(base, authMiddleware, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, spreadsheet: contactSpreadsheet.status(tenantId) });
  });
  app.post(`${base}/sync`, authMiddleware, async (req, res) => {
    try {
      const spreadsheet = await contactSpreadsheet.syncTenant(tenantId, { forceGoogle: true });
      auditSecurityAction?.(req, 'lead.spreadsheet.sync', 'contact_spreadsheet', 'success', { tenantId });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, spreadsheet });
    } catch {
      res.status(503).json({ ok: false, error: 'Falha ao atualizar a planilha. Os contatos permanecem salvos no sistema.' });
    }
  });
  app.get(`${base}/download`, authMiddleware, async (req, res) => {
    try {
      const result = await contactSpreadsheet.download(tenantId);
      auditSecurityAction?.(req, 'lead.export', 'contact_spreadsheet.csv', 'success', { tenantId, total: result.count });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `attachment; filename="contatos_${tenantId}.csv"`);
      res.send(result.csv);
    } catch {
      res.status(503).json({ ok: false, error: 'Planilha indispon\u00edvel. Verifique o status e tente novamente.' });
    }
  });
}
module.exports = { registerContactSpreadsheetRoutes };
