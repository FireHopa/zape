#!/usr/bin/env node
'use strict';
const { loadDatabaseConfig } = require('../src/database/config');
try {
  const config = loadDatabaseConfig();
  const warnings = [];
  if (config.mode === 'json') warnings.push('JSON continua como fonte principal.');
  if (config.mode === 'shadow') warnings.push(`Shadow temporário até ${process.env.PERSISTENCE_SHADOW_UNTIL}.`);
  console.log(JSON.stringify({ ok: true, mode: config.mode, dialect: config.dialect, databaseConfigured: Boolean(config.url), warnings }, null, 2));
} catch (error) { console.error(JSON.stringify({ ok: false, message: error.message }, null, 2)); process.exit(1); }
