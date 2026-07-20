#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const arg = process.argv.find((entry) => entry.startsWith('--env='));
if (!arg) throw new Error('Use --env=/caminho/staging.env');
const envFile = path.resolve(arg.slice('--env='.length));
const parsed = {};
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const index = line.indexOf('=');
  if (index < 1) continue;
  parsed[line.slice(0, index)] = line.slice(index + 1);
}
const errors = [];
const requireValue = (name) => {
  if (!String(parsed[name] || '').trim()) errors.push(`${name} ausente.`);
};
for (const name of ['NODE_ENV','ZAPE_DATA_DIR','SESSION_SECRET','CONFIG_ENCRYPTION_KEY','DATABASE_URL','REDIS_URL','STAGING_ENVIRONMENT_ID']) requireValue(name);
if (parsed.NODE_ENV !== 'staging') errors.push('NODE_ENV deve ser staging.');
if (parsed.STAGING_SYNTHETIC_ONLY !== '1') errors.push('STAGING_SYNTHETIC_ONLY deve ser 1.');
if (!/staging/i.test(parsed.ZAPE_DATA_DIR || '')) errors.push('ZAPE_DATA_DIR precisa apontar para diretório de staging.');
if (!/staging/i.test(parsed.DATABASE_URL || '')) errors.push('DATABASE_URL precisa identificar banco de staging.');
if (!/(\/15|db=15)(?:$|[?&])/i.test(parsed.REDIS_URL || '')) errors.push('REDIS_URL deve usar o banco lógico 15 de staging.');
if (parsed.PERSISTENCE_MODE !== 'database') errors.push('PERSISTENCE_MODE deve ser database.');
for (const name of ['WEBJS_ENABLED','WA_CLOUD_ENABLED','CRM_INTEGRATION_ENABLED']) {
  if (parsed[name] !== '0') errors.push(`${name} deve permanecer 0 até credenciais exclusivas de homologação serem configuradas.`);
}
if (/bobia\.com\.br|production|prod\b/i.test(parsed.PUBLIC_BASE_URL || '')) errors.push('PUBLIC_BASE_URL parece apontar para produção.');
const dataDir = path.resolve(parsed.ZAPE_DATA_DIR || '.');
if (!fs.existsSync(dataDir)) errors.push('Fixture sintética não existe.');
const files = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
const result = {
  ok: errors.length === 0,
  envFileHash: crypto.createHash('sha256').update(fs.readFileSync(envFile)).digest('hex'),
  syntheticOnly: parsed.STAGING_SYNTHETIC_ONLY === '1',
  tenantsEnabled: ['ADMIN','PANEL','REGINA','PORTUGAL','FELIPE','ANA'].filter((prefix) => parsed[`${prefix}_ENABLED`] === '1').length,
  dataDirectoryExists: fs.existsSync(dataDir),
  dataEntries: files.length,
  databaseIsolated: /staging/i.test(parsed.DATABASE_URL || ''),
  redisIsolated: /(\/15|db=15)(?:$|[?&])/i.test(parsed.REDIS_URL || ''),
  externalIntegrationsDisabled: ['WEBJS_ENABLED','WA_CLOUD_ENABLED','CRM_INTEGRATION_ENABLED'].every((name) => parsed[name] === '0'),
  errors,
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = errors.length ? 1 : 0;
