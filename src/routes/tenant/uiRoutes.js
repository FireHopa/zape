'use strict';

const fs = require('fs');
const path = require('path');
const { getTenantConfig } = require('../../authConfig');

const TENANT_LABEL_MARKER = '<meta name="zape-tenant-label" content="">';
let cachedTemplate = null;
let cachedTemplatePath = null;
let cachedTemplateMtime = 0;

function escapeHtmlAttribute(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function readTemplate(file) {
  const stat = fs.statSync(file);
  if (cachedTemplatePath !== file || cachedTemplateMtime !== Number(stat.mtimeMs)) {
    cachedTemplate = fs.readFileSync(file, 'utf8');
    cachedTemplatePath = file;
    cachedTemplateMtime = Number(stat.mtimeMs);
  }
  return cachedTemplate;
}

/**
 * @param {import('express').Application} app
 * @param {{ tenantId: string, authMiddleware: import('express').RequestHandler, projectRoot: string, frontendFeatureGate?: import('express').RequestHandler }} options
 */
function registerTenantUiRoutes(app, options) {
  const { tenantId, authMiddleware, projectRoot, frontendFeatureGate } = options;
  const middleware = frontendFeatureGate ? [authMiddleware, frontendFeatureGate] : [authMiddleware];
  app.get(`/${tenantId}`, ...middleware, (_req, res) => {
    const file = path.join(projectRoot, 'public', 'app.html');
    const cfg = getTenantConfig(tenantId);
    const label = cfg?.displayName || cfg?.realm || tenantId;
    const html = readTemplate(file).replace(
      TENANT_LABEL_MARKER,
      `<meta name="zape-tenant-label" content="${escapeHtmlAttribute(label)}">`
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  });
}

module.exports = { registerTenantUiRoutes };
