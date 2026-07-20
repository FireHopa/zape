#!/usr/bin/env node
'use strict';

const { createDatabase } = require('../src/database/client');
const { loadDatabaseConfig } = require('../src/database/config');
const { migrateDatabase } = require('../src/database/migrations');

(async () => {
  const config = loadDatabaseConfig();
  const db = createDatabase(config);
  try {
    const dryRun = process.argv.includes('--dry-run');
    const plan = await migrateDatabase(db, config.migrationsDir, { dryRun });
    console.log(JSON.stringify({ ok: true, dryRun, dialect: db.dialect, plan }, null, 2));
  } finally { await db.close(); }
})().catch((error) => { console.error(JSON.stringify({ ok: false, code: error.code || 'DB_MIGRATION_FAILED', message: error.message }, null, 2)); process.exit(1); });
