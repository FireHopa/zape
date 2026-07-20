'use strict';
const path = require('path');
const { listTenantIds, auditStatusesTenant } = require('../src/dataIntegrity');
const { parseArgs, resolveDataDir, resolveOutputPath, writeReport } = require('./data-integrity-cli');
const args = parseArgs(); const dataDir = resolveDataDir(args);
const tenants = listTenantIds(dataDir).map((tenantId) => auditStatusesTenant(path.join(dataDir, tenantId), tenantId));
const report = { reportVersion: 1, generatedAt: new Date().toISOString(), summary: { tenants: tenants.length, statuses: tenants.reduce((s,t)=>s+t.statuses,0), orphanStatuses: tenants.reduce((s,t)=>s+t.orphanStatuses,0), unmatchedRawReferences: tenants.reduce((s,t)=>s+t.unmatchedRawReferences,0), invalidKeys: tenants.reduce((s,t)=>s+t.invalidKeys,0) }, tenants };
writeReport(resolveOutputPath(args, 'audit-statuses.json'), report);
