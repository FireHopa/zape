'use strict';

const path = require('node:path');

function normalizeMode(value) {
  const mode = String(value || 'json').trim().toLowerCase();
  if (!['json', 'shadow', 'database'].includes(mode)) throw new Error('PERSISTENCE_MODE deve ser json, shadow ou database.');
  return mode;
}

function loadDatabaseConfig(env = process.env) {
  const mode = normalizeMode(env.PERSISTENCE_MODE);
  const url = String(env.DATABASE_URL || '').trim();
  const dialect = url.startsWith('sqlite:') ? 'sqlite' : 'postgres';
  if (mode !== 'json' && !url) throw new Error('DATABASE_URL é obrigatório quando PERSISTENCE_MODE não é json.');
  if (mode !== 'json' && dialect === 'sqlite' && String(env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('SQLite é permitido somente para testes e homologação local; produção exige PostgreSQL.');
  }
  if (mode === 'shadow') {
    const until = String(env.PERSISTENCE_SHADOW_UNTIL || '').trim();
    const owner = String(env.PERSISTENCE_SHADOW_OWNER || '').trim();
    if (!until || Number.isNaN(Date.parse(until))) throw new Error('PERSISTENCE_SHADOW_UNTIL válido é obrigatório no modo shadow.');
    if (!owner) throw new Error('PERSISTENCE_SHADOW_OWNER é obrigatório no modo shadow.');
    if (Date.parse(until) <= Date.now()) throw new Error('O prazo do modo shadow expirou. Faça o cutover ou volte para json.');
  }
  return {
    mode,
    url,
    dialect,
    ssl: String(env.DATABASE_SSL || 'require').toLowerCase(),
    max: Math.max(1, Math.min(30, Number(env.DATABASE_POOL_MAX || 10))),
    statementTimeoutMs: Math.max(1000, Number(env.DATABASE_STATEMENT_TIMEOUT_MS || 15000)),
    idleTimeoutMs: Math.max(1000, Number(env.DATABASE_IDLE_TIMEOUT_MS || 30000)),
    connectionTimeoutMs: Math.max(500, Number(env.DATABASE_CONNECTION_TIMEOUT_MS || 5000)),
    migrationsDir: path.resolve(env.DATABASE_MIGRATIONS_DIR || path.join(__dirname, '..', '..', 'db', 'migrations', dialect)),
  };
}

module.exports = { loadDatabaseConfig, normalizeMode };
