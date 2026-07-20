'use strict';
const path = require('path');
const { listTenantIds, auditCrmTenant } = require('../src/dataIntegrity');
const { parseArgs, resolveDataDir, resolveOutputPath, writeReport } = require('./data-integrity-cli');
const args = parseArgs(); const dataDir = resolveDataDir(args);
const tenants = listTenantIds(dataDir).map((tenantId) => auditCrmTenant(path.join(dataDir, tenantId), tenantId));
const report = { reportVersion: 1, generatedAt: new Date().toISOString(), summary: { tenants: tenants.length, references: tenants.reduce((s,t)=>s+t.references,0), missingLeadReferences: tenants.reduce((s,t)=>s+t.missingLeadReferences,0), duplicateReferences: tenants.reduce((s,t)=>s+t.duplicateReferences,0) }, tenants };
writeReport(resolveOutputPath(args, 'audit-crm.json'), report);
