'use strict';

const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  TENANT_ADMIN: 'tenant_admin',
  OPERATOR: 'operator',
  VIEWER: 'viewer',
});

const PERMISSIONS = Object.freeze({
  ALL: '*',
  UI_ACCESS: 'ui:access',
  LEADS_READ: 'leads:read',
  LEADS_CREATE: 'leads:create',
  LEADS_EDIT: 'leads:edit',
  LEADS_DELETE: 'leads:delete',
  LEADS_EXPORT: 'leads:export',
  CRM_READ: 'crm:read',
  CRM_WRITE: 'crm:write',
  WHATSAPP_READ: 'whatsapp:read',
  WHATSAPP_CONNECT: 'whatsapp:connect',
  WHATSAPP_SEND: 'whatsapp:send',
  ANALYTICS_READ: 'analytics:read',
  TAGS_READ: 'tags:read',
  TAGS_WRITE: 'tags:write',
  MESSAGE_TEMPLATE_READ: 'message_template:read',
  MESSAGE_TEMPLATE_WRITE: 'message_template:write',
  WEBHOOKS_READ: 'webhooks:read',
  WEBHOOKS_WRITE: 'webhooks:write',
  EXTERNAL_CRM_READ: 'external_crm:read',
  BUSINESS_READ: 'business:read',
  BUSINESS_WRITE: 'business:write',
  CLOUD_CONNECTION_VIEW: 'cloud_connection:view',
  CLOUD_CONNECTION_MANAGE: 'cloud_connection:manage',
  CLOUD_TEMPLATES_READ: 'cloud_templates:read',
  CLOUD_TEMPLATES_WRITE: 'cloud_templates:write',
  CLOUD_CAMPAIGNS_SEND: 'cloud_campaigns:send',
  CLOUD_SHEETS_READ: 'cloud_sheets:read',
  CLOUD_SHEETS_WRITE: 'cloud_sheets:write',
  CLOUD_STATUSES_READ: 'cloud_statuses:read',
  MONITORING_READ: 'monitoring:read',
  PRIVACY_MANAGE: 'privacy:manage',
  USERS_MANAGE: 'users:manage',
  TENANTS_MANAGE: 'tenants:manage',
});

const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.SUPER_ADMIN]: Object.freeze([PERMISSIONS.ALL]),
  [ROLES.TENANT_ADMIN]: Object.freeze([
    PERMISSIONS.UI_ACCESS,
    PERMISSIONS.LEADS_READ,
    PERMISSIONS.LEADS_CREATE,
    PERMISSIONS.LEADS_EDIT,
    PERMISSIONS.LEADS_DELETE,
    PERMISSIONS.LEADS_EXPORT,
    PERMISSIONS.CRM_READ,
    PERMISSIONS.CRM_WRITE,
    PERMISSIONS.WHATSAPP_READ,
    PERMISSIONS.WHATSAPP_CONNECT,
    PERMISSIONS.WHATSAPP_SEND,
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.TAGS_READ,
    PERMISSIONS.TAGS_WRITE,
    PERMISSIONS.MESSAGE_TEMPLATE_READ,
    PERMISSIONS.MESSAGE_TEMPLATE_WRITE,
    PERMISSIONS.WEBHOOKS_READ,
    PERMISSIONS.WEBHOOKS_WRITE,
    PERMISSIONS.EXTERNAL_CRM_READ,
    PERMISSIONS.BUSINESS_READ,
    PERMISSIONS.CLOUD_TEMPLATES_READ,
    PERMISSIONS.CLOUD_CAMPAIGNS_SEND,
    PERMISSIONS.CLOUD_SHEETS_READ,
    PERMISSIONS.CLOUD_SHEETS_WRITE,
    PERMISSIONS.CLOUD_STATUSES_READ,
    PERMISSIONS.PRIVACY_MANAGE,
    PERMISSIONS.USERS_MANAGE,
    PERMISSIONS.TENANTS_MANAGE,
  ]),
  [ROLES.OPERATOR]: Object.freeze([
    PERMISSIONS.UI_ACCESS,
    PERMISSIONS.LEADS_READ,
    PERMISSIONS.LEADS_CREATE,
    PERMISSIONS.LEADS_EDIT,
    PERMISSIONS.CRM_READ,
    PERMISSIONS.CRM_WRITE,
    PERMISSIONS.WHATSAPP_READ,
    PERMISSIONS.WHATSAPP_SEND,
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.TAGS_READ,
    PERMISSIONS.MESSAGE_TEMPLATE_READ,
    PERMISSIONS.WEBHOOKS_READ,
    PERMISSIONS.EXTERNAL_CRM_READ,
    PERMISSIONS.BUSINESS_READ,
    PERMISSIONS.CLOUD_TEMPLATES_READ,
    PERMISSIONS.CLOUD_CAMPAIGNS_SEND,
    PERMISSIONS.CLOUD_SHEETS_READ,
    PERMISSIONS.CLOUD_SHEETS_WRITE,
    PERMISSIONS.CLOUD_STATUSES_READ,
  ]),
  [ROLES.VIEWER]: Object.freeze([
    PERMISSIONS.UI_ACCESS,
    PERMISSIONS.LEADS_READ,
    PERMISSIONS.CRM_READ,
    PERMISSIONS.WHATSAPP_READ,
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.TAGS_READ,
    PERMISSIONS.MESSAGE_TEMPLATE_READ,
    PERMISSIONS.WEBHOOKS_READ,
    PERMISSIONS.EXTERNAL_CRM_READ,
    PERMISSIONS.BUSINESS_READ,
    PERMISSIONS.CLOUD_TEMPLATES_READ,
    PERMISSIONS.CLOUD_SHEETS_READ,
    PERMISSIONS.CLOUD_STATUSES_READ,
  ]),
});

const ALLOWED_ROLES = Object.freeze(Object.values(ROLES));

function clean(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function defaultRoleForTenant(tenantId) {
  return clean(tenantId) === 'admin' ? ROLES.SUPER_ADMIN : ROLES.TENANT_ADMIN;
}

function roleEnvName(tenantId) {
  return `${String(tenantId || '')
    .trim()
    .toUpperCase()}_ROLE`;
}

function resolveRoleForTenant(tenantId, env = process.env) {
  const tid = clean(tenantId);
  let configured = clean(env[roleEnvName(tid)]);
  if (!configured) {
    try {
      // Carregamento tardio evita ciclo na inicialização entre authorization/authConfig/tenantRegistry.
      const record = require('./tenantRegistry').getDynamicTenant(tid);
      configured = clean(record?.role);
    } catch {}
  }
  const role = configured || defaultRoleForTenant(tid);
  if (!ALLOWED_ROLES.includes(role)) return null;
  if (role === ROLES.SUPER_ADMIN && tid !== 'admin') return null;
  return role;
}

function permissionsForRole(role) {
  return Array.from(ROLE_PERMISSIONS[clean(role)] || []);
}

function hasPermission(auth, permission) {
  if (!auth || !permission) return false;
  const permissions = Array.isArray(auth.permissions) ? auth.permissions : [];
  return permissions.includes(PERMISSIONS.ALL) || permissions.includes(permission);
}

function buildAuthContext({ tenantId, username, sessionId, method, env = process.env, role: roleOverride }) {
  const tid = clean(tenantId);
  const role = clean(roleOverride) || resolveRoleForTenant(tid, env);
  if (!role || !ALLOWED_ROLES.includes(role)) return null;
  if (role === ROLES.SUPER_ADMIN && tid !== 'admin') return null;
  return {
    userId: `${tid}:${String(username || '').trim()}`,
    tenantId: tid,
    username: String(username || '').trim(),
    role,
    permissions: permissionsForRole(role),
    sessionId: sessionId || '',
    method: method || 'unknown',
  };
}

function deny(res, status, code, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ ok: false, code, error: message });
}

function requireAuth(req, res, next) {
  if (!req.auth || !req.auth.userId || !req.auth.tenantId) {
    return deny(res, 401, 'AUTH_REQUIRED', 'Autenticação obrigatória.');
  }
  return next();
}

function requireRole(...allowedRoles) {
  const allowed = new Set(allowedRoles.flat().map(clean).filter(Boolean));
  return function roleMiddleware(req, res, next) {
    if (!req.auth) return deny(res, 401, 'AUTH_REQUIRED', 'Autenticação obrigatória.');
    if (!allowed.has(clean(req.auth.role))) {
      return deny(res, 403, 'ROLE_FORBIDDEN', 'Você não possui permissão para esta ação.');
    }
    return next();
  };
}

function requirePermission(permission) {
  return function permissionMiddleware(req, res, next) {
    if (!req.auth) return deny(res, 401, 'AUTH_REQUIRED', 'Autenticação obrigatória.');
    if (!hasPermission(req.auth, permission)) {
      return deny(res, 403, 'PERMISSION_FORBIDDEN', 'Você não possui permissão para esta ação.');
    }
    return next();
  };
}

function requireTenant(expectedTenant) {
  return function tenantMiddleware(req, res, next) {
    if (!req.auth) return deny(res, 401, 'AUTH_REQUIRED', 'Autenticação obrigatória.');
    const expected = typeof expectedTenant === 'function' ? expectedTenant(req) : expectedTenant;
    if (!expected || clean(req.auth.tenantId) !== clean(expected)) {
      return deny(res, 403, 'TENANT_FORBIDDEN', 'Acesso entre tenants bloqueado.');
    }
    return next();
  };
}

function tenantFromPath(pathname) {
  const match = String(pathname || '').match(/^\/(?:api\/)?([a-z0-9](?:[a-z0-9-]{0,31}))(?:\/|$)/i);
  const candidate = match ? clean(match[1]) : '';
  if (!candidate) return '';
  try {
    // Somente o primeiro segmento de um tenant realmente registrado participa da proteção cruzada.
    return require('./authConfig').getTenantConfig(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

function permissionForTenantRequest(req, tenantId) {
  const method = String(req.method || 'GET').toUpperCase();
  const pathname = String(req.path || req.originalUrl || '').split('?')[0];
  const tid = clean(tenantId);
  if (pathname === `/${tid}`) return PERMISSIONS.UI_ACCESS;
  if (pathname === `/${tid}/leads.csv`) return PERMISSIONS.LEADS_EXPORT;

  const prefix = `/api/${tid}`;
  if (!pathname.startsWith(`${prefix}/`) && pathname !== prefix) return null;
  const relative = pathname.slice(prefix.length) || '/';

  if (relative === '/leads' && method === 'GET') return PERMISSIONS.LEADS_READ;
  if (relative === '/monitoring' && method === 'GET' && tid === 'admin') return PERMISSIONS.MONITORING_READ;
  if (relative === '/metrics' && method === 'GET' && tid === 'admin') return PERMISSIONS.MONITORING_READ;
  if (relative === '/deployment' && method === 'GET' && tid === 'admin') return PERMISSIONS.MONITORING_READ;
  if (relative === '/privacy/contact' && method === 'GET') return PERMISSIONS.PRIVACY_MANAGE;
  if (relative === '/privacy/contact/delete' && method === 'POST') return PERMISSIONS.PRIVACY_MANAGE;
  if (/^\/leads\/[^/]+$/.test(relative) && method === 'PUT') return PERMISSIONS.LEADS_EDIT;
  if (/^\/leads\/[^/]+\/merge$/.test(relative) && method === 'POST') return PERMISSIONS.LEADS_EDIT;
  if (/^\/leads\/[^/]+$/.test(relative) && method === 'DELETE') return PERMISSIONS.LEADS_DELETE;
  if (relative === '/leads/manual' && method === 'POST') return PERMISSIONS.LEADS_CREATE;
  if (/^\/leads\/[^/]+\/tags$/.test(relative) && method === 'POST') return PERMISSIONS.TAGS_WRITE;
  if (relative === '/leads/bulk-tags' && method === 'POST') return PERMISSIONS.TAGS_WRITE;

  if (relative === '/crm' && method === 'GET') return PERMISSIONS.CRM_READ;
  if (relative === '/crm' && method === 'PUT') return PERMISSIONS.CRM_WRITE;

  if (relative === '/whatsapp/status' && method === 'GET') return PERMISSIONS.WHATSAPP_READ;
  if (relative === '/whatsapp/qr' && method === 'GET') return PERMISSIONS.WHATSAPP_READ;
  if (relative === '/whatsapp/stats' && method === 'GET') return PERMISSIONS.WHATSAPP_READ;
  if (relative === '/whatsapp/init' && method === 'POST') return PERMISSIONS.WHATSAPP_CONNECT;
  if (relative === '/whatsapp/authentication' && method === 'DELETE') return PERMISSIONS.WHATSAPP_CONNECT;

  if (tid === 'felipe' && relative === '/users' && method === 'GET') return PERMISSIONS.USERS_MANAGE;
  if (tid === 'felipe' && relative === '/users' && method === 'POST') return PERMISSIONS.USERS_MANAGE;
  if (tid === 'felipe' && /^\/users\/[^/]+$/.test(relative) && ['PUT', 'DELETE'].includes(method)) return PERMISSIONS.USERS_MANAGE;

  if (tid === 'felipe' && relative === '/tenants' && method === 'GET') return PERMISSIONS.TENANTS_MANAGE;
  if (tid === 'felipe' && relative === '/tenants' && method === 'POST') return PERMISSIONS.TENANTS_MANAGE;
  if (tid === 'felipe' && /^\/tenants\/[^/]+$/.test(relative) && ['PUT', 'DELETE'].includes(method)) return PERMISSIONS.TENANTS_MANAGE;

  if (relative === '/insights' && method === 'GET') return PERMISSIONS.ANALYTICS_READ;

  if (relative === '/tags' && method === 'GET') return PERMISSIONS.TAGS_READ;
  if (relative === '/tags' && method === 'POST') return PERMISSIONS.TAGS_WRITE;
  if (/^\/tags\/[^/]+$/.test(relative) && method === 'DELETE') return PERMISSIONS.TAGS_WRITE;

  if (relative === '/message-template' && method === 'GET') return PERMISSIONS.MESSAGE_TEMPLATE_READ;
  if (relative === '/message-template' && method === 'POST') return PERMISSIONS.MESSAGE_TEMPLATE_WRITE;

  if (relative === '/webhooks' && method === 'GET') return PERMISSIONS.WEBHOOKS_READ;
  if (relative === '/webhooks' && method === 'POST') return PERMISSIONS.WEBHOOKS_WRITE;
  if (/^\/webhooks\/[^/]+$/.test(relative) && ['PUT', 'DELETE'].includes(method))
    return PERMISSIONS.WEBHOOKS_WRITE;

  if (relative.startsWith('/external-crm/') && method === 'GET') return PERMISSIONS.EXTERNAL_CRM_READ;

  if (relative === '/conversations' && method === 'GET') return PERMISSIONS.WHATSAPP_READ;
  if (/^\/conversations\/[^/]+\/messages$/.test(relative) && method === 'GET')
    return PERMISSIONS.WHATSAPP_READ;
  if (/^\/conversations\/[^/]+\/register$/.test(relative) && method === 'POST')
    return PERMISSIONS.LEADS_CREATE;
  if (/^\/conversations\/[^/]+\/media\/[^/]+$/.test(relative) && method === 'GET')
    return PERMISSIONS.WHATSAPP_READ;
  if (/^\/conversations\/[^/]+\/(messages|audio|attachments)$/.test(relative) && method === 'POST')
    return PERMISSIONS.WHATSAPP_SEND;

  return undefined;
}

function enforceTenantRequest(req, res, next, expectedTenant) {
  if (!req.auth) return deny(res, 401, 'AUTH_REQUIRED', 'Autenticação obrigatória.');
  const tid = clean(expectedTenant);
  if (clean(req.auth.tenantId) !== tid) {
    return deny(res, 403, 'TENANT_FORBIDDEN', 'Acesso entre tenants bloqueado.');
  }
  const pathTenant = tenantFromPath(req.path || req.originalUrl);
  if (pathTenant && pathTenant !== tid) {
    return deny(res, 403, 'TENANT_FORBIDDEN', 'Acesso entre tenants bloqueado.');
  }
  const permission = permissionForTenantRequest(req, tid);
  if (permission === undefined) {
    return deny(res, 403, 'ROUTE_POLICY_MISSING', 'A rota protegida não possui política de autorização.');
  }
  if (permission && !hasPermission(req.auth, permission)) {
    return deny(res, 403, 'PERMISSION_FORBIDDEN', 'Você não possui permissão para esta ação.');
  }
  return next();
}

module.exports = {
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ALLOWED_ROLES,
  defaultRoleForTenant,
  roleEnvName,
  resolveRoleForTenant,
  permissionsForRole,
  hasPermission,
  buildAuthContext,
  requireAuth,
  requireRole,
  requirePermission,
  requireTenant,
  tenantFromPath,
  permissionForTenantRequest,
  enforceTenantRequest,
};
