'use strict';
const fs = require('fs');
const path = require('path');
const {
  buildMigrationPlan,
  applyMigrationPlan,
  rollbackMigration,
  atomicWriteJson,
  auditDataDirectory,
} = require('../src/dataIntegrity');
const { parseArgs, resolveDataDir, resolveOutputPath } = require('./data-integrity-cli');

const args = parseArgs();
if (args.rollback) {
  const result = rollbackMigration(path.resolve(String(args.rollback)), { confirm: args.confirm });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}
const dataDir = resolveDataDir(args);
const outputPath = resolveOutputPath(args, 'data-integrity-migration-plan.json');
const plan = buildMigrationPlan(dataDir, { retentionDays: Number(args['retention-days'] || 30) });
const publicPlan = JSON.parse(JSON.stringify(plan));
for (const tenant of publicPlan.tenants) {
  delete tenant.outputFiles;
  for (const item of tenant.quarantine || []) {
    if (item.raw !== undefined) item.raw = '[redacted-in-public-plan]';
    if (item.value !== undefined) item.value = '[redacted-in-public-plan]';
    if (item.key !== undefined) item.key = `[hash:${require('../src/dataIntegrity').hashIdentifier(item.key)}]`;
    if (item.file !== undefined) item.file = `[hash:${require('../src/dataIntegrity').hashIdentifier(item.file)}]`;
    if (item.canonical !== undefined) item.canonical = `[hash:${require('../src/dataIntegrity').hashIdentifier(item.canonical)}]`;
  }
  for (const operation of tenant.operations || []) {
    for (const field of ['from', 'to', 'file', 'canonical']) {
      if (operation[field] !== undefined) operation[field] = `[hash:${require('../src/dataIntegrity').hashIdentifier(operation[field])}]`;
    }
  }
}
atomicWriteJson(outputPath, publicPlan);

if (!args.apply) {
  process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, output: outputPath, summary: plan.summary }, null, 2)}\n`);
  process.exit(0);
}

const beforeAudit = auditDataDirectory(dataDir);
const result = applyMigrationPlan(dataDir, plan, {
  confirm: args.confirm,
  confirmMedia: args['confirm-media'],
  backupDir: args['backup-dir'],
});
const afterAudit = auditDataDirectory(dataDir);
const resultPath = path.join(path.dirname(outputPath), 'data-integrity-migration-result.json');
atomicWriteJson(resultPath, {
  resultVersion: 1,
  migrationId: result.manifest.migrationId,
  completedAt: result.manifest.completedAt,
  manifestPath: result.manifestPath,
  before: beforeAudit.summary,
  after: afterAudit.summary,
});
process.stdout.write(`${JSON.stringify({ ok: true, dryRun: false, plan: outputPath, result: resultPath, manifest: result.manifestPath, before: beforeAudit.summary, after: afterAudit.summary }, null, 2)}\n`);
