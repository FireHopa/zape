'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizePhoneToE164Digits } = require('../phone');
const { jsonParam, boolParam } = require('../repositories/helpers');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stableId(prefix, ...parts) { return `${prefix}_${sha256(parts.map((x) => String(x ?? '')).join('\0')).slice(0, 24)}`; }
function now() { return new Date().toISOString(); }
function safeJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function jsonl(file) {
  if (!fs.existsSync(file)) return { rows: [], invalid: [] };
  const rows = []; const invalid = [];
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try { rows.push(JSON.parse(line)); }
    catch { invalid.push({ lineNumber: index + 1, rawHash: sha256(line), raw: line }); }
  });
  return { rows, invalid };
}
function filesRecursive(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}
function sourceChecksum(dataDir) {
  const hash = crypto.createHash('sha256');
  for (const file of filesRecursive(dataDir)) {
    const relative = path.relative(dataDir, file).replace(/\\/g, '/');
    hash.update(relative); hash.update('\0'); hash.update(fs.readFileSync(file)); hash.update('\0');
  }
  return hash.digest('hex');
}
function tenantIds(dataDir) {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9_-]{1,64}$/i.test(entry.name) && !['quarantine', 'backups', 'exports'].includes(entry.name))
    .map((entry) => entry.name.toLowerCase()).sort();
}
function extractStages(pipeline) {
  const stages = pipeline?.stages;
  if (Array.isArray(stages)) return stages;
  if (stages && typeof stages === 'object') {
    const order = Array.isArray(pipeline.stageOrder) ? pipeline.stageOrder : Object.keys(stages);
    return order.map((id) => stages[id]).filter(Boolean);
  }
  return [];
}
function normalizeMessage(phone, message, index, tenantId) {
  const external = String(message?.id || message?._serialized || '').trim();
  const id = external || stableId('msg', tenantId, phone, index, message?.timestamp, message?.body);
  const createdAt = message?.createdAt || (message?.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : now());
  return { id, external, createdAt, direction: message?.fromMe ? 'outbound' : 'inbound', type: String(message?.type || 'chat'), body: message?.body == null ? null : String(message.body), payload: message || {} };
}

function buildImportPlan(dataDir) {
  const absolute = path.resolve(dataDir);
  const checksum = sourceChecksum(absolute);
  const plan = {
    schemaVersion: 1,
    generatedAt: now(),
    sourceChecksum: checksum,
    sourcePathHash: sha256(absolute),
    tenants: [],
    totals: { tenants: 0, leads: 0, tags: 0, leadTags: 0, funnels: 0, stages: 0, funnelLeads: 0, conversations: 0, messages: 0, statuses: 0, webhooks: 0, cloudCampaigns: 0, cloudDispatches: 0, jobs: 0, quarantined: 0 },
    quarantine: [],
  };
  for (const tenantId of tenantIds(absolute)) {
    const dir = path.join(absolute, tenantId);
    const leads = jsonl(path.join(dir, 'leads.jsonl'));
    for (const invalid of leads.invalid) plan.quarantine.push({ tenantId, sourceFile: `${tenantId}/leads.jsonl`, sourceLine: invalid.lineNumber, reasonCode: 'INVALID_JSONL', rawHash: invalid.rawHash });
    const tags = safeJson(path.join(dir, 'tags.json'), []);
    const leadTags = safeJson(path.join(dir, 'lead_tags.json'), {});
    const crm = safeJson(path.join(dir, 'crm.json'), {});
    const conversations = safeJson(path.join(dir, 'conversations.json'), {});
    const statuses = safeJson(path.join(dir, 'message_status.json'), {});
    const tenantPlan = {
      tenantId,
      dir,
      leads: leads.rows,
      tags: Array.isArray(tags) ? tags : Object.values(tags || {}),
      leadTags: leadTags && typeof leadTags === 'object' ? leadTags : {},
      crm: crm && typeof crm === 'object' ? crm : {},
      conversations: conversations && typeof conversations === 'object' ? conversations : {},
      statuses: statuses && typeof statuses === 'object' ? statuses : {},
    };
    plan.tenants.push(tenantPlan);
    plan.totals.tenants += 1;
    plan.totals.leads += tenantPlan.leads.length;
    plan.totals.tags += tenantPlan.tags.length;
    plan.totals.leadTags += Object.values(tenantPlan.leadTags).reduce((sum, row) => sum + (Array.isArray(row) ? row.length : 0), 0);
    const pipelines = Array.isArray(tenantPlan.crm.pipelines) ? tenantPlan.crm.pipelines : [];
    plan.totals.funnels += pipelines.length;
    for (const pipeline of pipelines) {
      const stages = extractStages(pipeline);
      plan.totals.stages += stages.length;
      plan.totals.funnelLeads += stages.reduce((sum, stage) => sum + (Array.isArray(stage?.leadIds) ? stage.leadIds.length : 0), 0);
    }
    plan.totals.conversations += Object.keys(tenantPlan.conversations).length;
    plan.totals.messages += Object.values(tenantPlan.conversations).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
    plan.totals.statuses += Object.keys(tenantPlan.statuses).length;
  }
  plan.totals.quarantined = plan.quarantine.length;
  const webhooks = safeJson(path.join(absolute, 'webhooks.json'), []);
  plan.webhooks = Array.isArray(webhooks) ? webhooks : [];
  plan.totals.webhooks = plan.webhooks.length;
  plan.cloudConfig = safeJson(path.join(absolute, 'wa_cloud_config.json'), {});
  plan.cloud = safeJson(path.join(absolute, 'wa_cloud_dispatches.json'), { campaigns: [], events: [] });
  plan.jobs = safeJson(path.join(absolute, 'wa_cloud_jobs.json'), { jobs: [] });
  plan.totals.cloudCampaigns = Array.isArray(plan.cloud?.campaigns) ? plan.cloud.campaigns.length : 0;
  plan.totals.cloudDispatches = Array.isArray(plan.cloud?.events) ? plan.cloud.events.length : 0;
  plan.totals.jobs = Array.isArray(plan.jobs?.jobs) ? plan.jobs.jobs.length : 0;
  return plan;
}

async function insertDefaults(tx) {
  const roles = ['super_admin', 'tenant_admin', 'operator', 'viewer'];
  for (const role of roles) await tx.query('INSERT INTO roles(id,name) VALUES ($1,$2) ON CONFLICT(id) DO NOTHING', [role, role]);
}
async function upsertTenant(tx, tenantId) {
  const timestamp = now();
  await tx.query('INSERT INTO tenants(id,name,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING', [tenantId, tenantId, 'active', timestamp, timestamp]);
  const userId = `${tenantId}:configured`;
  await tx.query('INSERT INTO users(id,tenant_id,username,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING', [userId, tenantId, 'configured-user', 'active', timestamp, timestamp]);
  const role = tenantId === 'admin' ? 'super_admin' : 'tenant_admin';
  await tx.query('INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2) ON CONFLICT(user_id,role_id) DO NOTHING', [userId, role]);
}
async function importTenant(tx, item, report) {
  const tenantId = item.tenantId;
  await upsertTenant(tx, tenantId);
  for (const lead of item.leads) {
    const id = String(lead?.id || stableId('lead', tenantId, JSON.stringify(lead))).trim();
    const phone = normalizePhoneToE164Digits(lead?.whatsapp_digits || lead?.whatsapp_raw || lead?.whatsapp || lead?.phone || lead?.telefone || '') || null;
    try {
      const result = await tx.query(`INSERT INTO leads(id,tenant_id,phone_normalized,name,company,email,website,advertises,source,payload,version,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`, [
        id, tenantId, phone, lead?.nome || null, lead?.empresa || null, lead?.email || null, lead?.website || null, lead?.jaAnuncia || null,
        lead?.source || null, jsonParam(tx, lead), 1, lead?.createdAt || now(), lead?.updatedAt || lead?.createdAt || now(),
      ]);
      report.inserted.leads += result.rowCount;
      if (lead?.source && result.rowCount) await tx.query('INSERT INTO lead_sources(lead_id,tenant_id,source,metadata,created_at) VALUES ($1,$2,$3,$4,$5)', [id, tenantId, String(lead.source), jsonParam(tx, lead?.sourceMeta || {}), lead?.createdAt || now()]);
    } catch (error) {
      const rawHash = sha256(JSON.stringify(lead));
      report.quarantined += 1;
      await tx.query('INSERT INTO import_quarantine(batch_id,tenant_id,source_file,source_line,reason_code,raw_hash,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(batch_id,source_file,source_line,raw_hash) DO NOTHING', [report.batchId, tenantId, `${tenantId}/leads.jsonl`, null, 'LEAD_CONSTRAINT_CONFLICT', rawHash, jsonParam(tx, { code: String(error?.code || '') }), now()]);
    }
  }
  for (const tag of item.tags) {
    const id = String(tag?.id || stableId('tag', tenantId, tag?.name || JSON.stringify(tag)));
    const result = await tx.query('INSERT INTO tags(id,tenant_id,name,color,metadata) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [id, tenantId, String(tag?.name || id), tag?.color || null, jsonParam(tx, tag || {})]);
    report.inserted.tags += result.rowCount;
  }
  for (const [leadId, tagIds] of Object.entries(item.leadTags)) {
    for (const tagId of Array.isArray(tagIds) ? tagIds : []) {
      const result = await tx.query('INSERT INTO lead_tags(tenant_id,lead_id,tag_id) SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM leads WHERE tenant_id=$1 AND id=$2) AND EXISTS (SELECT 1 FROM tags WHERE tenant_id=$1 AND id=$3) ON CONFLICT DO NOTHING', [tenantId, String(leadId), String(tagId)]);
      report.inserted.leadTags += result.rowCount;
    }
  }
  const pipelines = Array.isArray(item.crm?.pipelines) ? item.crm.pipelines : [];
  for (let pi = 0; pi < pipelines.length; pi += 1) {
    const pipeline = pipelines[pi];
    const funnelId = String(pipeline?.id || stableId('funnel', tenantId, pi));
    await tx.query('INSERT INTO funnels(id,tenant_id,name,is_active,metadata,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,id) DO NOTHING', [funnelId, tenantId, String(pipeline?.name || 'Funil'), boolParam(tx, item.crm.activePipelineId === funnelId || pi === 0), jsonParam(tx, pipeline || {}), pipeline?.createdAt || now(), item.crm.updatedAt || now()]);
    report.inserted.funnels += 1;
    const stages = extractStages(pipeline);
    for (let si = 0; si < stages.length; si += 1) {
      const stage = stages[si];
      const stageId = String(stage?.id || stableId('stage', tenantId, funnelId, si));
      await tx.query('INSERT INTO funnel_stages(id,tenant_id,funnel_id,name,position,metadata) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,funnel_id,id) DO NOTHING', [stageId, tenantId, funnelId, String(stage?.name || stageId), si, jsonParam(tx, stage || {})]);
      report.inserted.stages += 1;
      for (let li = 0; li < (Array.isArray(stage?.leadIds) ? stage.leadIds.length : 0); li += 1) {
        const leadId = String(stage.leadIds[li]);
        const result = await tx.query('INSERT INTO funnel_leads(tenant_id,funnel_id,stage_id,lead_id,position,updated_at) SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM leads WHERE tenant_id=$1 AND id=$4) ON CONFLICT DO NOTHING', [tenantId, funnelId, stageId, leadId, li, now()]);
        report.inserted.funnelLeads += result.rowCount;
      }
    }
  }
  for (const [phoneRaw, messages] of Object.entries(item.conversations)) {
    const phone = normalizePhoneToE164Digits(phoneRaw) || String(phoneRaw).replace(/\D/g, '');
    if (!phone) continue;
    const conversationId = stableId('conv', tenantId, phone);
    await tx.query('INSERT INTO conversations(id,tenant_id,phone_normalized,external_id,metadata,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,phone_normalized) DO NOTHING', [conversationId, tenantId, phone, phoneRaw, jsonParam(tx, {}), now(), now()]);
    report.inserted.conversations += 1;
    const rows = Array.isArray(messages) ? messages : [];
    for (let index = 0; index < rows.length; index += 1) {
      const message = normalizeMessage(phone, rows[index], index, tenantId);
      const result = await tx.query('INSERT INTO messages(id,tenant_id,conversation_id,external_message_id,direction,message_type,body,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING', [message.id, tenantId, conversationId, message.external || null, message.direction, message.type, message.body, jsonParam(tx, message.payload), message.createdAt]);
      report.inserted.messages += result.rowCount;
    }
  }
  for (const [externalId, statusValue] of Object.entries(item.statuses)) {
    const rows = Array.isArray(statusValue) ? statusValue : [statusValue];
    for (const statusRow of rows) {
      const status = typeof statusRow === 'string' ? statusRow : String(statusRow?.status || statusRow?.ack || 'unknown');
      const at = statusRow?.occurredAt || statusRow?.updatedAt || statusRow?.at || now();
      await tx.query('INSERT INTO message_status_history(tenant_id,message_id,external_message_id,status,provider,payload,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [tenantId, null, externalId, status, 'whatsapp-web', jsonParam(tx, statusRow || {}), at]);
      report.inserted.statuses += 1;
    }
  }
}

async function applyImportPlan(db, plan, { batchId = `import_${plan.sourceChecksum.slice(0, 20)}` } = {}) {
  const existing = await db.query('SELECT id,status,report FROM import_batches WHERE source_checksum=$1', [plan.sourceChecksum]);
  if (existing.rows.length) {
    const savedReport = typeof existing.rows[0].report === 'string' ? JSON.parse(existing.rows[0].report) : existing.rows[0].report;
    return { idempotent: true, batchId: existing.rows[0].id, report: savedReport };
  }
  const report = { batchId, sourceChecksum: plan.sourceChecksum, inserted: { leads: 0, tags: 0, leadTags: 0, funnels: 0, stages: 0, funnelLeads: 0, conversations: 0, messages: 0, statuses: 0, webhooks: 0, cloudCampaigns: 0, cloudDispatches: 0, jobs: 0 }, quarantined: 0 };
  await db.transaction(async (tx) => {
    await tx.query('INSERT INTO import_batches(id,source_checksum,source_path_hash,status,report,started_at) VALUES ($1,$2,$3,$4,$5,$6)', [batchId, plan.sourceChecksum, plan.sourcePathHash, 'running', jsonParam(tx, report), now()]);
    await insertDefaults(tx);
    for (const item of plan.tenants) await importTenant(tx, item, report);
    for (const row of plan.quarantine) {
      await tx.query('INSERT INTO import_quarantine(batch_id,tenant_id,source_file,source_line,reason_code,raw_hash,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(batch_id,source_file,source_line,raw_hash) DO NOTHING', [batchId, row.tenantId, row.sourceFile, row.sourceLine, row.reasonCode, row.rawHash, jsonParam(tx, {}), now()]);
      report.quarantined += 1;
    }
    for (const webhook of plan.webhooks) {
      const tenantId = String(webhook?.tenantId || webhook?.tenant || 'admin').toLowerCase();
      await upsertTenant(tx, tenantId);
      const id = String(webhook?.id || stableId('webhook', tenantId, webhook?.tokenHash || webhook?.token || JSON.stringify(webhook)));
      const result = await tx.query('INSERT INTO webhook_integrations(id,tenant_id,integration_type,token_hash,encrypted_secret,configuration,enabled,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING', [id, tenantId, String(webhook?.type || 'custom'), webhook?.tokenHash || null, webhook?.secretEncrypted ? JSON.stringify(webhook.secretEncrypted) : null, jsonParam(tx, { ...webhook, token: undefined, secret: undefined }), boolParam(tx, webhook?.enabled !== false), webhook?.createdAt || now(), webhook?.updatedAt || now()]);
      report.inserted.webhooks += result.rowCount;
    }
    const config = plan.cloudConfig || {};
    const connectionTenant = String(config.tenantId || 'admin').toLowerCase();
    await upsertTenant(tx, connectionTenant);
    const connectionId = String(config.connectionId || stableId('conn', config.phoneNumberId || 'legacy', config.wabaId || 'legacy'));
    if (config.phoneNumberId || (plan.cloud?.campaigns || []).length || (plan.cloud?.events || []).length) {
      await tx.query('INSERT INTO cloud_connections(id,tenant_id,phone_number_id,waba_id,app_id,encrypted_access_token,encrypted_app_secret,configuration,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING', [connectionId, connectionTenant, String(config.phoneNumberId || 'legacy-unconfigured'), String(config.wabaId || 'legacy-unconfigured'), config.appId || null, config.accessTokenEncrypted ? JSON.stringify(config.accessTokenEncrypted) : null, config.appSecretEncrypted ? JSON.stringify(config.appSecretEncrypted) : null, jsonParam(tx, { ...config, accessToken: undefined, appSecret: undefined }), config.enabled ? 'active' : 'inactive', config.createdAt || now(), config.updatedAt || now()]);
    }
    for (const campaign of Array.isArray(plan.cloud?.campaigns) ? plan.cloud.campaigns : []) {
      const tenantId = String(campaign?.tenantId || connectionTenant).toLowerCase(); await upsertTenant(tx, tenantId);
      const result = await tx.query('INSERT INTO cloud_campaigns(id,tenant_id,connection_id,job_id,name,template_name,language_code,state,total,progress,payload,idempotency_key_hash,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO NOTHING', [campaign.id || stableId('camp', tenantId, JSON.stringify(campaign)), tenantId, campaign.connectionId || connectionId, campaign.jobId || null, campaign.name || campaign.campaignName || 'Campanha', campaign.templateName || '', campaign.languageCode || 'pt_BR', campaign.state || 'draft', Number(campaign.total || 0), jsonParam(tx, campaign.progress || {}), jsonParam(tx, campaign), campaign.idempotencyKeyHash || null, campaign.createdAt || now(), campaign.updatedAt || now()]);
      report.inserted.cloudCampaigns += result.rowCount;
    }
    for (const event of Array.isArray(plan.cloud?.events) ? plan.cloud.events : []) {
      const tenantId = String(event?.tenantId || connectionTenant).toLowerCase(); await upsertTenant(tx, tenantId);
      let campaignId = event.campaignId || null;
      if (campaignId) {
        const campaignExists = await tx.query('SELECT id FROM cloud_campaigns WHERE id=$1', [campaignId]);
        if (!campaignExists.rows.length) campaignId = null;
      }
      const result = await tx.query('INSERT INTO cloud_dispatches(id,tenant_id,connection_id,campaign_id,recipient_id,external_message_id,state,payload,status_history,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING', [event.id || event.dispatchId || stableId('dispatch', tenantId, JSON.stringify(event)), tenantId, event.connectionId || connectionId, campaignId, String(event.recipientId || event.toDigits || ''), event.messageId || null, event.status || 'queued', jsonParam(tx, event), jsonParam(tx, event.statusHistory || []), event.createdAt || now(), event.updatedAt || now()]);
      report.inserted.cloudDispatches += result.rowCount;
    }
    for (const job of Array.isArray(plan.jobs?.jobs) ? plan.jobs.jobs : []) {
      const tenantId = String(job?.tenantId || 'admin').toLowerCase(); await upsertTenant(tx, tenantId);
      const result = await tx.query('INSERT INTO jobs(id,tenant_id,job_type,state,idempotency_key_hash,payload,progress,attempts,max_attempts,next_run_at,locked_at,locked_by,last_error,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(id) DO NOTHING', [job.id || stableId('job', tenantId, JSON.stringify(job)), tenantId, job.type || job.jobType || 'cloud_campaign', job.state || 'queued', job.idempotencyKeyHash || null, jsonParam(tx, job.payload || job), jsonParam(tx, job.progress || {}), Number(job.attempts || 0), Number(job.maxAttempts || 1), job.nextRunAt || null, job.lockedAt || null, job.lockedBy || null, job.lastError ? jsonParam(tx, job.lastError) : null, job.createdAt || now(), job.updatedAt || now()]);
      report.inserted.jobs += result.rowCount;
    }
    await tx.query('UPDATE import_batches SET status=$1,report=$2,completed_at=$3 WHERE id=$4', ['completed', jsonParam(tx, report), now(), batchId]);
  });
  return { idempotent: false, batchId, report };
}

module.exports = { buildImportPlan, applyImportPlan, sourceChecksum, stableId };
