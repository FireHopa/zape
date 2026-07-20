'use strict';

const { loadDatabaseConfig } = require('./config');
const { createDatabase } = require('./client');
const { migrateDatabase } = require('./migrations');
const { databaseHealth } = require('./health');
const { LeadRepository, RepositoryConflictError } = require('../repositories/leadRepository');
const { leadVersion } = require('../tenantLeadsStore');

const state = { config: null, db: null, leadRepository: null, leadCache: new Map(), initialized: false };

function legacyLead(row) {
  if (!row) return null;
  return {
    ...(row.payload || {}),
    id: row.id,
    nome: row.nome || row.payload?.nome || '',
    empresa: row.empresa || row.payload?.empresa || '',
    email: row.email || row.payload?.email || '',
    website: row.website || row.payload?.website || '',
    jaAnuncia: row.jaAnuncia || row.payload?.jaAnuncia || '',
    source: row.source || row.payload?.source || '',
    whatsapp_digits: row.phoneNormalized || row.payload?.whatsapp_digits || '',
    whatsapp_raw: row.payload?.whatsapp_raw || row.phoneNormalized || '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    _databaseVersion: row.version,
  };
}
function cacheTenant(tenantId, rows) { state.leadCache.set(String(tenantId), rows.map(legacyLead)); }
function upsertCache(tenantId, lead) {
  const key = String(tenantId); const rows = state.leadCache.get(key) || []; const next = legacyLead(lead);
  const index = rows.findIndex((row) => String(row.id) === String(next.id));
  if (index >= 0) rows[index] = next; else rows.unshift(next);
  state.leadCache.set(key, rows);
  return next;
}
async function loadLeadCache() {
  const tenants = await state.db.query('SELECT id FROM tenants ORDER BY id');
  for (const tenant of tenants.rows) {
    const rows = []; let page = 1;
    while (true) {
      const result = await state.leadRepository.list(tenant.id, { page, pageSize: 500 });
      rows.push(...result.items);
      if (!result.hasNext) break;
      page += 1;
    }
    cacheTenant(tenant.id, rows);
  }
}
async function initializeDatabaseRuntime() {
  if (state.initialized) return state;
  state.config = loadDatabaseConfig();
  if (state.config.mode === 'json') { state.initialized = true; return state; }
  state.db = createDatabase(state.config);
  await migrateDatabase(state.db, state.config.migrationsDir);
  state.leadRepository = new LeadRepository(state.db);
  await databaseHealth(state.db);
  if (state.config.mode === 'database') await loadLeadCache();
  state.initialized = true;
  return state;
}
function mode() { return state.config?.mode || loadDatabaseConfig().mode; }
function isDatabasePrimary() { return mode() === 'database'; }
function isShadow() { return mode() === 'shadow'; }
function readLeadsFromCache(tenantId) { return (state.leadCache.get(String(tenantId)) || []).map((row) => ({ ...row })); }
async function createLead(tenantId, lead) {
  const created = await state.leadRepository.create({ ...lead, tenantId }, { sourceMetadata: lead.sourceMeta || {} });
  return upsertCache(tenantId, created);
}
async function updateLead(tenantId, leadId, expectedHash, patch, actorUserId) {
  const cached = readLeadsFromCache(tenantId).find((row) => String(row.id) === String(leadId));
  if (!cached) return null;
  if (leadVersion(cached) !== String(expectedHash || '')) throw new RepositoryConflictError('LEAD_VERSION_CONFLICT', 'O lead foi alterado por outra operação.');
  const updated = await state.leadRepository.update(tenantId, leadId, cached._databaseVersion, patch, actorUserId);
  return upsertCache(tenantId, updated);
}
async function mergeLeads(tenantId, targetId, sourceId, targetHash, sourceHash, actorUserId) {
  const rows = readLeadsFromCache(tenantId);
  const target = rows.find((row) => String(row.id) === String(targetId));
  const source = rows.find((row) => String(row.id) === String(sourceId));
  if (!target || !source) return null;
  if (leadVersion(target) !== String(targetHash || '') || leadVersion(source) !== String(sourceHash || '')) throw new RepositoryConflictError('LEAD_VERSION_CONFLICT', 'Um dos leads foi alterado.');
  const merged = await state.leadRepository.merge(tenantId, targetId, sourceId, target._databaseVersion, source._databaseVersion, actorUserId);
  const key = String(tenantId); const nextRows = (state.leadCache.get(key) || []).filter((row) => String(row.id) !== String(sourceId));
  state.leadCache.set(key, nextRows); return upsertCache(tenantId, merged);
}
async function deleteLead(tenantId, leadId) {
  const existing = readLeadsFromCache(tenantId).find((row) => String(row.id) === String(leadId));
  if (!existing) return null;
  await state.db.transaction(async (tx) => {
    await tx.query('INSERT INTO lead_changes(lead_id,tenant_id,change_type,before_data,after_data,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [leadId, tenantId, 'delete', state.db.dialect === 'postgres' ? existing : JSON.stringify(existing), null, state.db.dialect === 'postgres' ? {} : '{}', new Date().toISOString()]);
    await tx.query('DELETE FROM leads WHERE tenant_id=$1 AND id=$2', [tenantId, leadId]);
  });
  state.leadCache.set(String(tenantId), (state.leadCache.get(String(tenantId)) || []).filter((row) => String(row.id) !== String(leadId)));
  return existing;
}
async function health() { return state.db ? databaseHealth(state.db) : { ok: true, dialect: null, mode: 'json' }; }
async function close() { if (state.db) await state.db.close(); state.db = null; state.initialized = false; state.leadCache.clear(); }
function getState() { return state; }

module.exports = { initializeDatabaseRuntime, isDatabasePrimary, isShadow, readLeadsFromCache, createLead, updateLead, mergeLeads, deleteLead, health, close, getState, legacyLead };
