'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  auditDataDirectory,
  buildMigrationPlan,
  applyMigrationPlan,
  rollbackMigration,
  validateDataIntegrityOnBoot,
  fileSha256,
  sha256,
} = require('../src/dataIntegrity');
const { deleteLeadById, readLeads } = require('../src/tenantLeadsStore');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zape-phase7-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeJsonl(file, rows, rawLines = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = rows.map((row) => JSON.stringify(row)).concat(rawLines);
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
}

function buildFixture(root) {
  const dataDir = path.join(root, 'data');
  const tenantDir = path.join(dataDir, 'admin');
  const phone = '5511999999999';
  const secondPhone = '5511888888888';
  const duplicateBuffer = Buffer.from('same-media-content');
  fs.mkdirSync(path.join(tenantDir, 'conversation_media'), { recursive: true });
  fs.writeFileSync(path.join(tenantDir, 'conversation_media', 'a.bin'), duplicateBuffer);
  fs.writeFileSync(path.join(tenantDir, 'conversation_media', 'b.bin'), duplicateBuffer);
  fs.writeFileSync(path.join(tenantDir, 'conversation_media', 'orphan.bin'), Buffer.from('orphan'));
  const old = new Date(Date.now() - 90 * 86400000);
  fs.utimesSync(path.join(tenantDir, 'conversation_media', 'orphan.bin'), old, old);

  writeJsonl(path.join(tenantDir, 'leads.jsonl'), [
    { id: 'lead-a', nome: 'A', whatsapp_digits: phone, email: 'a@example.invalid', createdAt: '2024-01-01T00:00:00.000Z', source: 'form', tags: ['t1'] },
    { id: 'lead-b', empresa: 'Empresa', whatsapp_raw: '(11) 99999-9999', createdAt: '2024-01-02T00:00:00.000Z', source: 'webhook', tags: ['t2'] },
    { id: 'lead-c', nome: 'C', whatsapp_digits: secondPhone, createdAt: '2024-01-03T00:00:00.000Z' },
  ]);
  writeJson(path.join(tenantDir, 'conversations.json'), {
    [phone]: [
      { id: 'msg-a', timestamp: 1, body: 'arquivo', mediaFile: 'b.bin', mediaId: 'b.bin', hasMedia: true },
      { id: 'msg-missing', timestamp: 2, body: 'ausente', mediaFile: 'missing.bin', hasMedia: true },
    ],
    '0': [{ id: 'bad', body: 'invalid' }],
  });
  writeJson(path.join(tenantDir, 'message_status.json'), {
    [phone]: { ack: 2, lastSendAt: '2024-01-01T00:00:00.000Z' },
    '999': { ack: 1 },
  });
  writeJson(path.join(tenantDir, 'crm.json'), {
    version: 1,
    activePipelineId: 'p1',
    pipelines: [{ id: 'p1', stageOrder: ['s1', 's2'], stages: {
      s1: { id: 's1', leadIds: ['lead-b'] },
      s2: { id: 's2', leadIds: ['lead-a'] },
    }}],
  });
  writeJson(path.join(tenantDir, 'tags.json'), [{ id: 't1' }, { id: 't2' }]);
  writeJson(path.join(tenantDir, 'lead_tags.json'), { 'lead-a': ['t1'], 'lead-b': ['t2'] });
  return { dataDir, tenantDir, phone, secondPhone };
}

function treeDigest(root) {
  const rows = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) rows.push(`${path.relative(root, full)}:${fileSha256(full)}:${fs.statSync(full).size}`);
    }
  }
  walk(root);
  return sha256(rows.join('\n'));
}

test('auditoria contabiliza duplicidades, órfãos e referências sem expor PII', () => {
  const root = tempRoot();
  try {
    const { dataDir } = buildFixture(root);
    const report = auditDataDirectory(dataDir);
    assert.equal(report.summary.leads, 3);
    assert.equal(report.summary.duplicatePhoneGroups, 1);
    assert.equal(report.summary.duplicateLeadRows, 1);
    assert.equal(report.summary.invalidConversationKeys, 1);
    assert.equal(report.summary.orphanStatuses, 1);
    assert.equal(report.summary.missingMediaReferences, 1);
    assert.equal(report.summary.duplicateMediaFiles, 1);
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /99999-9999|a@example\.invalid|Empresa/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('plano determinístico consolida leads e atualiza CRM, tags, status, conversa e mídia', () => {
  const root = tempRoot();
  try {
    const { dataDir } = buildFixture(root);
    const plan = buildMigrationPlan(dataDir, { retentionDays: 30 });
    assert.equal(plan.summary.leadMerges, 1);
    assert.equal(plan.summary.leadsBefore, 3);
    assert.equal(plan.summary.leadsAfter, 2);
    const tenant = plan.tenants[0];
    const leads = tenant.outputFiles['leads.jsonl'].trim().split('\n').map(JSON.parse);
    const merged = leads.find((lead) => Array.isArray(lead.mergedLeadIds));
    assert.ok(merged);
    assert.deepEqual(new Set(merged.tags), new Set(['t1', 't2']));
    assert.ok(merged.mergedOrigins.length >= 2);
    assert.ok(merged.mergedFieldAlternates || merged.empresa === 'Empresa');

    const crm = JSON.parse(tenant.outputFiles['crm.json']);
    const refs = crm.pipelines.flatMap((pipeline) => Object.values(pipeline.stages).flatMap((stage) => stage.leadIds));
    assert.equal(refs.filter((id) => id === merged.id).length, 1);
    const leadTags = JSON.parse(tenant.outputFiles['lead_tags.json']);
    assert.deepEqual(new Set(leadTags[merged.id]), new Set(['t1', 't2']));

    const conversations = JSON.parse(tenant.outputFiles['conversations.json']);
    assert.equal(Object.hasOwn(conversations, '0'), false);
    assert.equal(conversations[merged.whatsapp_digits][0].mediaFile, 'a.bin');
    assert.equal(conversations[merged.whatsapp_digits][1].mediaUnavailable, true);
    const statuses = JSON.parse(tenant.outputFiles['message_status.json']);
    assert.equal(Object.hasOwn(statuses, '999'), false);
    assert.equal(tenant.quarantine.some((item) => item.type === 'status'), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('aplicação é idempotente e rollback restaura checksum exato', () => {
  const root = tempRoot();
  try {
    const { dataDir } = buildFixture(root);
    const before = treeDigest(dataDir);
    const plan = buildMigrationPlan(dataDir, { retentionDays: 30 });
    const result = applyMigrationPlan(dataDir, plan, {
      confirm: 'APPLY_DATA_INTEGRITY',
      confirmMedia: 'QUARANTINE_ORPHAN_MEDIA',
      backupDir: path.join(root, 'backup'),
    });
    const secondPlan = buildMigrationPlan(dataDir, { retentionDays: 30 });
    assert.equal(secondPlan.summary.leadMerges, 0);
    assert.equal(secondPlan.summary.changedFiles, 0);
    assert.equal(secondPlan.summary.quarantineRecords, 0);
    assert.equal(fs.existsSync(path.join(dataDir, 'admin', '.zape-data-manifest.json')), true);
    rollbackMigration(result.manifestPath, { confirm: 'ROLLBACK_DATA_INTEGRITY' });
    assert.equal(treeDigest(dataDir), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('migração e rollback exigem confirmações explícitas', () => {
  const root = tempRoot();
  try {
    const { dataDir } = buildFixture(root);
    const plan = buildMigrationPlan(dataDir, { retentionDays: 30 });
    assert.throws(() => applyMigrationPlan(dataDir, plan, { backupDir: path.join(root, 'backup') }), /confirmation_required/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tenantLeadsStore copia linha inválida para quarentena e não a apaga ao excluir lead', () => {
  const root = tempRoot();
  const previous = process.env.ZAPE_DATA_DIR;
  const previousQuarantine = process.env.LEADS_INVALID_LINE_QUARANTINE;
  try {
    const dataDir = path.join(root, 'data');
    const tenantDir = path.join(dataDir, 'admin');
    writeJsonl(path.join(tenantDir, 'leads.jsonl'), [
      { id: 'keep', whatsapp_digits: '5511999999999', createdAt: '2024-01-01T00:00:00.000Z' },
      { id: 'remove', whatsapp_digits: '5511888888888', createdAt: '2024-01-02T00:00:00.000Z' },
    ], ['{"broken":']);
    process.env.ZAPE_DATA_DIR = dataDir;
    process.env.LEADS_INVALID_LINE_QUARANTINE = '1';
    assert.equal(readLeads('admin').length, 2);
    const quarantine = path.join(tenantDir, 'quarantine', 'invalid_leads_runtime.jsonl');
    assert.equal(fs.existsSync(quarantine), true);
    const result = deleteLeadById('admin', 'remove');
    assert.equal(result.ok, true);
    const after = fs.readFileSync(path.join(tenantDir, 'leads.jsonl'), 'utf8');
    assert.match(after, /\{"broken":/);
    assert.match(after, /"id":"keep"/);
    assert.doesNotMatch(after, /"id":"remove"/);
  } finally {
    if (previous === undefined) delete process.env.ZAPE_DATA_DIR; else process.env.ZAPE_DATA_DIR = previous;
    if (previousQuarantine === undefined) delete process.env.LEADS_INVALID_LINE_QUARANTINE; else process.env.LEADS_INVALID_LINE_QUARANTINE = previousQuarantine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validação estrita de boot detecta corrupção e checksum divergente', () => {
  const root = tempRoot();
  try {
    const { dataDir, tenantDir } = buildFixture(root);
    const plan = buildMigrationPlan(dataDir, { retentionDays: 30 });
    applyMigrationPlan(dataDir, plan, { confirm: 'APPLY_DATA_INTEGRITY', backupDir: path.join(root, 'backup') });
    let validation = validateDataIntegrityOnBoot(dataDir, { strict: true });
    assert.equal(validation.valid, true);
    fs.appendFileSync(path.join(tenantDir, 'leads.jsonl'), '{"tampered":true}\n');
    assert.throws(
      () => validateDataIntegrityOnBoot(dataDir, { strict: true }),
      (error) => error.code === 'DATA_INTEGRITY_BOOT_FAILED'
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
