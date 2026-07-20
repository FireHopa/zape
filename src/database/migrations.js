'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function checksum(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function migrationFiles(dir) {
  if (!fs.existsSync(dir)) throw new Error(`Diretório de migrations inexistente: ${dir}`);
  return fs.readdirSync(dir).filter((name) => /^\d+_.+\.sql$/.test(name)).sort().map((name) => ({
    version: name.replace(/\.sql$/, ''),
    file: path.join(dir, name),
    sql: fs.readFileSync(path.join(dir, name), 'utf8'),
  }));
}
async function ensureTable(db) {
  if (db.dialect === 'postgres') {
    await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  } else {
    await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  }
}
async function appliedMap(db) {
  await ensureTable(db);
  const result = await db.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
  return new Map(result.rows.map((row) => [String(row.version), String(row.checksum)]));
}
async function migrateDatabase(db, migrationsDir, { dryRun = false } = {}) {
  const applied = await appliedMap(db);
  const plan = [];
  for (const item of migrationFiles(migrationsDir)) {
    const hash = checksum(item.sql);
    if (applied.has(item.version)) {
      if (applied.get(item.version) !== hash) throw new Error(`Checksum divergente na migration já aplicada: ${item.version}`);
      plan.push({ version: item.version, checksum: hash, action: 'already_applied' });
      continue;
    }
    plan.push({ version: item.version, checksum: hash, action: dryRun ? 'would_apply' : 'applied' });
    if (dryRun) continue;
    await db.transaction(async (tx) => {
      await tx.exec(item.sql);
      const at = new Date().toISOString();
      await tx.query('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES ($1,$2,$3)', [item.version, hash, at]);
    });
  }
  return plan;
}

module.exports = { migrateDatabase, migrationFiles, checksum };
