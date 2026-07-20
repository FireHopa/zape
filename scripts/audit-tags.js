'use strict';
const path = require('path');
const { listTenantIds, auditTagsTenant } = require('../src/dataIntegrity');
const { parseArgs, resolveDataDir, resolveOutputPath, writeReport } = require('./data-integrity-cli');
const args = parseArgs(); const dataDir = resolveDataDir(args);
const tenants = listTenantIds(dataDir).map((tenantId) => auditTagsTenant(path.join(dataDir, tenantId), tenantId));
const report = { reportVersion: 1, generatedAt: new Date().toISOString(), summary: { tenants: tenants.length, tags: tenants.reduce((s,t)=>s+t.tags,0), leadMappings: tenants.reduce((s,t)=>s+t.leadMappings,0), missingLeads: tenants.reduce((s,t)=>s+t.missingLeads,0), missingTags: tenants.reduce((s,t)=>s+t.missingTags,0) }, tenants };
writeReport(resolveOutputPath(args, 'audit-tags.json'), report);
