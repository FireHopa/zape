'use strict';

const fs = require('fs');
const path = require('path');

function dataRoot() {
  const configured = String(process.env.ZAPE_DATA_DIR || '').trim();
  return configured ? path.resolve(configured) : path.join(__dirname, '..', 'data');
}

function tenantDir(tenantId) {
  const t = String(tenantId || '').trim() || 'admin';
  if (!/^[a-z0-9_-]{1,64}$/i.test(t)) throw new Error('Tenant inválido.');
  return path.join(dataRoot(), t);
}

function ensureTenantDir(tenantId) {
  const dir = tenantDir(tenantId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { dataRoot, tenantDir, ensureTenantDir };
