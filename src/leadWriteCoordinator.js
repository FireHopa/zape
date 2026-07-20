'use strict';

const pendingByTenant = new Map();

function withTenantLeadWrite(tenantId, operation) {
  const key = String(tenantId || '').trim();
  if (!key) return Promise.reject(new Error('tenantId obrigatório para escrita de lead.'));
  const previous = pendingByTenant.get(key) || Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.catch(() => undefined);
  pendingByTenant.set(key, settled);
  settled.finally(() => {
    if (pendingByTenant.get(key) === settled) pendingByTenant.delete(key);
  });
  return current;
}

function pendingTenantWrites() {
  return pendingByTenant.size;
}

module.exports = { withTenantLeadWrite, pendingTenantWrites };
