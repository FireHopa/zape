'use strict';
const path = require('path');
const { listTenantIds, auditMediaTenant } = require('../src/dataIntegrity');
const { parseArgs, resolveDataDir, resolveOutputPath, writeReport } = require('./data-integrity-cli');
const args = parseArgs(); const dataDir = resolveDataDir(args);
const tenants = listTenantIds(dataDir).map((tenantId) => auditMediaTenant(path.join(dataDir, tenantId), tenantId));
const report = { reportVersion: 1, generatedAt: new Date().toISOString(), summary: { tenants: tenants.length, physicalFiles: tenants.reduce((s,t)=>s+t.physicalFiles,0), references: tenants.reduce((s,t)=>s+t.references,0), missingReferences: tenants.reduce((s,t)=>s+t.missingReferences,0), orphanFiles: tenants.reduce((s,t)=>s+t.orphanFiles,0), duplicateExtraFiles: tenants.reduce((s,t)=>s+t.duplicateExtraFiles,0), duplicateBytesRecoverable: tenants.reduce((s,t)=>s+t.duplicateBytesRecoverable,0) }, tenants };
writeReport(resolveOutputPath(args, 'audit-media.json'), report);
