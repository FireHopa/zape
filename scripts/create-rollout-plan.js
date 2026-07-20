#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ALLOWED_TENANTS, FEATURES } = require('../src/deploymentControl');
function arg(name, fallback = '') {
  const p = `--${name}=`;
  const v = process.argv.find((x) => x.startsWith(p));
  return v ? v.slice(p.length) : fallback;
}
const releaseId = arg('release-id', process.env.RELEASE_ID || 'release-pending');
const order = arg('tenants', ALLOWED_TENANTS.join(','))
  .split(',')
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);
const invalid = order.filter((tenant) => !ALLOWED_TENANTS.includes(tenant));
if (invalid.length) throw new Error(`Tenants inválidos: ${invalid.join(', ')}`);
const observationMinutes = Math.max(5, Number(arg('observation-minutes', '30')) || 30);
const plan = {
  schemaVersion: 1,
  releaseId,
  generatedAt: new Date().toISOString(),
  strategy: 'tenant_feature_flags',
  observationMinutes,
  featureOrder: [
    FEATURES.FRONTEND_V2,
    FEATURES.LEAD_PAGINATION,
    FEATURES.SECURE_MEDIA,
    FEATURES.CLOUD_API_V2,
    FEATURES.CLOUD_QUEUE,
    FEATURES.DATABASE_PERSISTENCE,
  ],
  waves: order.map((tenantId, index) => ({
    wave: index + 1,
    tenantId,
    minimumObservationMinutes: observationMinutes,
    advanceCriteria: ['health_ok', 'no_5xx_increase', 'queue_not_stalled', 'login_ok', 'tenant_smoke_ok'],
    rollbackAction: 'disable_feature_for_tenant_or_repoint_previous_release',
  })),
};
const output = arg('output');
if (output) {
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(path.resolve(output), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify(plan, null, 2));
