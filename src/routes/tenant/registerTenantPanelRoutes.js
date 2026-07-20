'use strict';

const { registerTenantUiRoutes } = require('./uiRoutes');
const { registerLeadRoutes } = require('./leadRoutes');
const { registerCrmRoutes } = require('./crmRoutes');
const { registerWhatsappWebRoutes } = require('./whatsappWebRoutes');
const { registerContentRoutes } = require('./contentRoutes');
const { registerWebhookManagementRoutes } = require('./webhookManagementRoutes');
const { registerFelipeTenantRoutes } = require('./felipeTenantRoutes');

/**
 * Registers the common tenant UI and API surface once, using the authenticated
 * tenant configuration supplied by the bootstrap. Tenant identity never comes
 * from query strings or request bodies.
 *
 * @param {import('express').Application} app
 * @param {any} options
 */
function registerTenantPanelRoutes(app, options) {
  registerTenantUiRoutes(app, options);
  registerLeadRoutes(app, options);
  registerCrmRoutes(app, options);
  registerWhatsappWebRoutes(app, options);
  registerContentRoutes(app, options);
  registerWebhookManagementRoutes(app, options);
  registerFelipeTenantRoutes(app, options);
}

module.exports = { registerTenantPanelRoutes };
