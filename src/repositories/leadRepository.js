'use strict';

const { normalizePhoneToE164Digits } = require('../phone');
const { jsonParam, parseJson, isUniqueViolation } = require('./helpers');

class RepositoryConflictError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'RepositoryConflictError'; this.code = code; this.statusCode = 409; this.details = details;
  }
}

function normalizeLead(input = {}) {
  const now = new Date().toISOString();
  const phone = normalizePhoneToE164Digits(input.phone_normalized || input.whatsapp_digits || input.whatsapp_raw || input.whatsapp || input.phone || input.telefone || '');
  return {
    id: String(input.id || '').trim(),
    tenantId: String(input.tenantId || input.tenant_id || '').trim().toLowerCase(),
    phoneNormalized: phone || null,
    name: String(input.name ?? input.nome ?? '').trim() || null,
    company: String(input.company ?? input.empresa ?? '').trim() || null,
    email: String(input.email ?? '').trim().toLowerCase() || null,
    website: String(input.website ?? '').trim() || null,
    advertises: String(input.advertises ?? input.jaAnuncia ?? '').trim() || null,
    source: String(input.source || '').trim() || null,
    payload: input.payload && typeof input.payload === 'object' ? input.payload : { ...input },
    createdAt: input.createdAt || input.created_at || now,
    updatedAt: input.updatedAt || input.updated_at || now,
    version: Math.max(1, Number(input.version || 1)),
  };
}

function publicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    phoneNormalized: row.phone_normalized,
    nome: row.name,
    empresa: row.company,
    email: row.email,
    website: row.website,
    jaAnuncia: row.advertises,
    source: row.source,
    payload: parseJson(row.payload, {}),
    version: Number(row.version || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class LeadRepository {
  constructor(db) { this.db = db; }

  async create(input, { sourceMetadata = {} } = {}) {
    const lead = normalizeLead(input);
    if (!lead.id || !lead.tenantId) throw new Error('Lead exige id e tenantId.');
    try {
      return await this.db.transaction(async (tx) => {
        const result = await tx.query(`INSERT INTO leads
          (id,tenant_id,phone_normalized,name,company,email,website,advertises,source,payload,version,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [
          lead.id, lead.tenantId, lead.phoneNormalized, lead.name, lead.company, lead.email, lead.website,
          lead.advertises, lead.source, jsonParam(tx, lead.payload), lead.version, lead.createdAt, lead.updatedAt,
        ]);
        if (lead.source) {
          await tx.query('INSERT INTO lead_sources(lead_id,tenant_id,source,metadata,created_at) VALUES ($1,$2,$3,$4,$5)', [
            lead.id, lead.tenantId, lead.source, jsonParam(tx, sourceMetadata), lead.createdAt,
          ]);
        }
        return publicRow(result.rows[0]);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new RepositoryConflictError('LEAD_UNIQUE_CONFLICT', 'Já existe um lead com este telefone no tenant.', { phoneNormalized: lead.phoneNormalized });
      throw error;
    }
  }

  async getById(tenantId, id) {
    const result = await this.db.query('SELECT * FROM leads WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
    return publicRow(result.rows[0]);
  }

  async list(tenantId, { page = 1, pageSize = 100, q = '' } = {}) {
    const safePage = Math.max(1, Number(page || 1));
    const safeSize = Math.max(1, Math.min(500, Number(pageSize || 100)));
    const offset = (safePage - 1) * safeSize;
    const search = String(q || '').trim().toLowerCase();
    const where = search ? ` AND (LOWER(COALESCE(name,'')) LIKE $2 OR LOWER(COALESCE(company,'')) LIKE $2 OR LOWER(COALESCE(email,'')) LIKE $2 OR COALESCE(phone_normalized,'') LIKE $2)` : '';
    const countParams = search ? [tenantId, `%${search}%`] : [tenantId];
    const count = await this.db.query(`SELECT COUNT(*) AS total FROM leads WHERE tenant_id=$1${where}`, countParams);
    const params = search ? [tenantId, `%${search}%`, safeSize, offset] : [tenantId, safeSize, offset];
    const limitPos = search ? 3 : 2;
    const rows = await this.db.query(`SELECT * FROM leads WHERE tenant_id=$1${where} ORDER BY created_at DESC,id DESC LIMIT $${limitPos} OFFSET $${limitPos + 1}`, params);
    const total = Number(count.rows[0]?.total || 0);
    return { items: rows.rows.map(publicRow), total, page: safePage, pageSize: safeSize, totalPages: Math.max(1, Math.ceil(total / safeSize)), hasNext: offset + rows.rows.length < total };
  }

  async update(tenantId, id, expectedVersion, patch, actorUserId = null) {
    const current = await this.getById(tenantId, id);
    if (!current) return null;
    if (Number(current.version) !== Number(expectedVersion)) throw new RepositoryConflictError('LEAD_VERSION_CONFLICT', 'O lead foi alterado por outra operação.', { currentVersion: current.version });
    const phoneOverride = patch && (patch.whatsapp ?? patch.phone ?? patch.telefone ?? patch.phone_normalized ?? patch.phoneNormalized);
    const mergedInput = { ...current.payload, ...current, ...patch, id, tenantId, version: current.version + 1, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    if (phoneOverride !== undefined) mergedInput.phone_normalized = phoneOverride;
    delete mergedInput._version;
    const merged = normalizeLead(mergedInput);
    try {
      return await this.db.transaction(async (tx) => {
        const result = await tx.query(`UPDATE leads SET phone_normalized=$1,name=$2,company=$3,email=$4,website=$5,advertises=$6,source=$7,payload=$8,version=version+1,updated_at=$9
          WHERE tenant_id=$10 AND id=$11 AND version=$12 RETURNING *`, [merged.phoneNormalized, merged.name, merged.company, merged.email, merged.website, merged.advertises, merged.source, jsonParam(tx, merged.payload), merged.updatedAt, tenantId, id, expectedVersion]);
        if (!result.rows.length) throw new RepositoryConflictError('LEAD_VERSION_CONFLICT', 'O lead foi alterado por outra operação.');
        const after = publicRow(result.rows[0]);
        await tx.query('INSERT INTO lead_changes(lead_id,tenant_id,actor_user_id,change_type,before_data,after_data,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
          id, tenantId, actorUserId, 'update', jsonParam(tx, current), jsonParam(tx, after), jsonParam(tx, {}), merged.updatedAt,
        ]);
        return after;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new RepositoryConflictError('LEAD_PHONE_CONFLICT', 'O telefone já pertence a outro lead.');
      throw error;
    }
  }

  async merge(tenantId, targetId, sourceId, expectedTargetVersion, expectedSourceVersion, actorUserId = null) {
    return this.db.transaction(async (tx) => {
      const targetRows = await tx.query('SELECT * FROM leads WHERE tenant_id=$1 AND id=$2', [tenantId, targetId]);
      const sourceRows = await tx.query('SELECT * FROM leads WHERE tenant_id=$1 AND id=$2', [tenantId, sourceId]);
      const target = publicRow(targetRows.rows[0]);
      const source = publicRow(sourceRows.rows[0]);
      if (!target || !source) return null;
      if (target.version !== Number(expectedTargetVersion) || source.version !== Number(expectedSourceVersion)) throw new RepositoryConflictError('LEAD_VERSION_CONFLICT', 'Um dos leads foi alterado.');
      const payload = { ...source.payload, ...target.payload, mergedLeadIds: [...new Set([...(target.payload.mergedLeadIds || []), source.id])] };
      await tx.query('UPDATE lead_tags SET lead_id=$1 WHERE tenant_id=$2 AND lead_id=$3 AND NOT EXISTS (SELECT 1 FROM lead_tags x WHERE x.tenant_id=$2 AND x.lead_id=$1 AND x.tag_id=lead_tags.tag_id)', [targetId, tenantId, sourceId]);
      await tx.query('DELETE FROM lead_tags WHERE tenant_id=$1 AND lead_id=$2', [tenantId, sourceId]);
      await tx.query('DELETE FROM funnel_leads WHERE tenant_id=$1 AND lead_id=$2 AND EXISTS (SELECT 1 FROM funnel_leads x WHERE x.tenant_id=$1 AND x.lead_id=$3 AND x.funnel_id=funnel_leads.funnel_id)', [tenantId, sourceId, targetId]);
      await tx.query('UPDATE funnel_leads SET lead_id=$1 WHERE tenant_id=$2 AND lead_id=$3', [targetId, tenantId, sourceId]);
      await tx.query('DELETE FROM leads WHERE tenant_id=$1 AND id=$2 AND version=$3', [tenantId, sourceId, expectedSourceVersion]);
      const updated = await tx.query('UPDATE leads SET payload=$1,version=version+1,updated_at=$2 WHERE tenant_id=$3 AND id=$4 AND version=$5 RETURNING *', [jsonParam(tx, payload), new Date().toISOString(), tenantId, targetId, expectedTargetVersion]);
      if (!updated.rows.length) throw new RepositoryConflictError('LEAD_VERSION_CONFLICT', 'Lead de destino foi alterado.');
      const after = publicRow(updated.rows[0]);
      await tx.query('INSERT INTO lead_changes(lead_id,tenant_id,actor_user_id,change_type,before_data,after_data,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [targetId, tenantId, actorUserId, 'merge', jsonParam(tx, { target, source }), jsonParam(tx, after), jsonParam(tx, { sourceLeadId: sourceId }), new Date().toISOString()]);
      return after;
    });
  }
}

module.exports = { LeadRepository, RepositoryConflictError, normalizeLead, publicRow };
