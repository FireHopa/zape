'use strict';

const crypto = require('crypto');
const {
  listPublicDynamicTenants,
  createDynamicTenant,
  updateDynamicTenant,
  deleteDynamicTenant,
} = require('../../tenantRegistry');
const { inspectTenantSession } = require('../../whatsappSessionGuard');

function safeEqualText(left, right) {
  const a = Buffer.from(String(left ?? '').trim(), 'utf8');
  const b = Buffer.from(String(right ?? '').trim(), 'utf8');
  const max = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(max);
  const pb = Buffer.alloc(max);
  a.copy(pa);
  b.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && a.length === b.length;
}

function sendError(res, error) {
  const status = Number(error?.statusCode) || 500;
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  return res.status(safeStatus).json({
    ok: false,
    code: error?.code || 'TENANT_MANAGEMENT_FAILED',
    error: error?.message || 'Não foi possível concluir a operação.',
  });
}

function requirePrimaryFelipe(req, res, next) {
  const expected = String(process.env.FELIPE_USER || '').trim();
  if (req.auth?.tenantId !== 'felipe' || !expected || !safeEqualText(req.auth?.username, expected)) {
    return res.status(403).json({
      ok: false,
      code: 'TENANT_MANAGEMENT_FORBIDDEN',
      error: 'Somente o usuário principal do painel Felipe pode criar e gerenciar painéis completos.',
    });
  }
  return next();
}

function enrichTenant(tenant) {
  let whatsappSession;
  try { whatsappSession = inspectTenantSession(tenant.tenantId); }
  catch { whatsappSession = { authenticationExists: false, requiresCleanup: false }; }
  return { ...tenant, whatsappSession };
}

/**
 * @param {import('express').Application} app
 * @param {{
 *  tenantId: string,
 *  authMiddleware: import('express').RequestHandler,
 *  onDynamicTenantCreated?: Function,
 *  onDynamicTenantUpdated?: Function,
 *  onDynamicTenantDeleted?: Function,
 *  auditSecurityAction?: Function
 * }} options
 */
function registerFelipeTenantRoutes(app, options) {
  const {
    tenantId,
    authMiddleware,
    onDynamicTenantCreated,
    onDynamicTenantUpdated,
    onDynamicTenantDeleted,
    auditSecurityAction,
  } = options;
  if (tenantId !== 'felipe') return;
  const prefix = '/api/felipe/tenants';

  app.get(prefix, authMiddleware, requirePrimaryFelipe, (req, res) => {
    try {
      const items = listPublicDynamicTenants().map(enrichTenant);
      return res.json({ ok: true, canManage: true, actor: req.auth.username, items });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post(prefix, authMiddleware, requirePrimaryFelipe, async (req, res) => {
    try {
      const result = await createDynamicTenant({
        tenantId: req.body?.tenantId,
        displayName: req.body?.displayName,
        username: req.body?.username,
        password: req.body?.password,
        enabled: req.body?.enabled !== false,
      });
      if (typeof onDynamicTenantCreated === 'function') {
        await onDynamicTenantCreated(result.tenant);
      }
      auditSecurityAction?.(req, 'tenant.create', 'dynamic_tenant', 'success', { tenantId: result.tenant.tenantId });
      return res.status(201).json({
        ok: true,
        tenant: enrichTenant(result.tenant),
        availableImmediately: true,
        loginUrl: `/login?tenant=${encodeURIComponent(result.tenant.tenantId)}`,
      });
    } catch (error) {
      auditSecurityAction?.(req, 'tenant.create', 'dynamic_tenant', 'failed', { code: error?.code || 'TENANT_CREATE_FAILED' });
      return sendError(res, error);
    }
  });

  app.put(`${prefix}/:tenantId`, authMiddleware, requirePrimaryFelipe, async (req, res) => {
    try {
      const result = await updateDynamicTenant({
        tenantId: req.params.tenantId,
        displayName: Object.prototype.hasOwnProperty.call(req.body || {}, 'displayName') ? req.body.displayName : undefined,
        username: Object.prototype.hasOwnProperty.call(req.body || {}, 'username') ? req.body.username : undefined,
        password: Object.prototype.hasOwnProperty.call(req.body || {}, 'password') ? req.body.password : undefined,
        enabled: Object.prototype.hasOwnProperty.call(req.body || {}, 'enabled') ? req.body.enabled : undefined,
      });
      if (typeof onDynamicTenantUpdated === 'function') {
        await onDynamicTenantUpdated(result.tenant);
      }
      auditSecurityAction?.(req, 'tenant.update', 'dynamic_tenant', 'success', { tenantId: result.tenant.tenantId, enabled: result.tenant.enabled });
      return res.json({ ok: true, tenant: enrichTenant(result.tenant), availableImmediately: true });
    } catch (error) {
      auditSecurityAction?.(req, 'tenant.update', 'dynamic_tenant', 'failed', { tenantId: req.params.tenantId, code: error?.code || 'TENANT_UPDATE_FAILED' });
      return sendError(res, error);
    }
  });

  app.delete(`${prefix}/:tenantId`, authMiddleware, requirePrimaryFelipe, async (req, res) => {
    try {
      const requestedId = String(req.params.tenantId || '').trim().toLowerCase();
      const confirmation = String(req.body?.confirmation || '').trim().toUpperCase();
      const expected = `EXCLUIR ${requestedId.toUpperCase()}`;
      if (confirmation !== expected) {
        return res.status(400).json({ ok: false, code: 'CONFIRMATION_REQUIRED', error: `Digite ${expected} para confirmar.` });
      }
      const session = inspectTenantSession(requestedId);
      if (session.authenticationExists) {
        return res.status(409).json({
          ok: false,
          code: 'WHATSAPP_AUTHENTICATION_EXISTS',
          error: 'Este painel ainda possui autenticação do WhatsApp. Remova a autenticação dentro do próprio painel antes de excluí-lo.',
          whatsappSession: session,
        });
      }
      const result = await deleteDynamicTenant({ tenantId: requestedId });
      if (typeof onDynamicTenantDeleted === 'function') {
        await onDynamicTenantDeleted(result.tenant);
      }
      auditSecurityAction?.(req, 'tenant.delete', 'dynamic_tenant', 'success', { tenantId: requestedId, dataPreserved: true });
      return res.json({
        ok: true,
        tenant: result.tenant,
        dataPreserved: true,
        dataDirectory: result.dataDirectory,
      });
    } catch (error) {
      auditSecurityAction?.(req, 'tenant.delete', 'dynamic_tenant', 'failed', { tenantId: req.params.tenantId, code: error?.code || 'TENANT_DELETE_FAILED' });
      return sendError(res, error);
    }
  });
}

module.exports = { registerFelipeTenantRoutes, requirePrimaryFelipe };
