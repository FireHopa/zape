'use strict';
const path = require('path');
const { listTenantIds, auditLeadsTenant } = require('../src/dataIntegrity');
const { parseArgs, resolveDataDir, resolveOutputPath, writeReport } = require('./data-integrity-cli');
const args = parseArgs(); const dataDir = resolveDataDir(args);
const tenants = listTenantIds(dataDir).map((tenantId) => auditLeadsTenant(path.join(dataDir, tenantId), tenantId));
const report = { reportVersion: 1, generatedAt: new Date().toISOString(), summary: { tenants: tenants.length, validRecords: tenants.reduce((s,t)=>s+t.validRecords,0), invalidLines: tenants.reduce((s,t)=>s+t.invalidLines,0), duplicatePhoneGroups: tenants.reduce((s,t)=>s+t.duplicatePhoneGroups,0), duplicateExtraRows: tenants.reduce((s,t)=>s+t.duplicateExtraRows,0) }, tenants };
writeReport(resolveOutputPath(args, 'audit-leads.json'), report);
