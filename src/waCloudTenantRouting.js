'use strict';

function clean(value) {
  return String(value || '').trim();
}

function cleanTenant(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function parsePhoneTenantMap(rawValue = process.env.WA_CLOUD_PHONE_TENANT_MAP) {
  const raw = clean(rawValue);
  if (!raw) return {};

  if (raw.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const wrapped = new Error('WA_CLOUD_PHONE_TENANT_MAP contém JSON inválido.');
      wrapped.code = 'WA_CLOUD_PHONE_TENANT_MAP_INVALID';
      wrapped.cause = error;
      throw wrapped;
    }
    return Object.fromEntries(Object.entries(parsed || {})
      .map(([phoneNumberId, tenantId]) => [clean(phoneNumberId), cleanTenant(tenantId)])
      .filter(([phoneNumberId, tenantId]) => phoneNumberId && tenantId));
  }

  const out = {};
  for (const item of raw.split(',')) {
    const separator = item.includes('=') ? '=' : ':';
    const [phoneNumberId, tenantId] = item.split(separator, 2);
    const phone = clean(phoneNumberId);
    const tenant = cleanTenant(tenantId);
    if (phone && tenant) out[phone] = tenant;
  }
  return out;
}

function resolveCloudInboundTenant({ phoneNumberId, matchedTenantId, ownerTenantId, isTenantAllowed } = {}) {
  const matched = cleanTenant(matchedTenantId);
  if (matched && (!isTenantAllowed || isTenantAllowed(matched))) {
    return { tenantId: matched, method: 'campaign_correlation' };
  }

  const map = parsePhoneTenantMap();
  const mapped = cleanTenant(map[clean(phoneNumberId)]);
  if (mapped) {
    if (isTenantAllowed && !isTenantAllowed(mapped)) {
      const error = new Error(`Tenant ${mapped} configurado para a Cloud API não existe ou está desativado.`);
      error.code = 'WA_CLOUD_TENANT_MAP_TARGET_INVALID';
      throw error;
    }
    return { tenantId: mapped, method: 'phone_number_id_map' };
  }

  const fallback = cleanTenant(process.env.WA_CLOUD_DEFAULT_TENANT || ownerTenantId || process.env.WA_CLOUD_CONNECTION_OWNER_TENANT || 'admin') || 'admin';
  if (isTenantAllowed && !isTenantAllowed(fallback)) {
    const error = new Error(`Tenant padrão ${fallback} da Cloud API não existe ou está desativado.`);
    error.code = 'WA_CLOUD_DEFAULT_TENANT_INVALID';
    throw error;
  }
  return { tenantId: fallback, method: 'default_tenant' };
}

module.exports = {
  parsePhoneTenantMap,
  resolveCloudInboundTenant,
};
