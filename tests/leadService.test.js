'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publicLead, updateLead, mergeLeads, LeadServiceError } = require('../src/leadService');
const { readLeads } = require('../src/tenantLeadsStore');
const { getLeadTagsMap } = require('../src/tenantLeadTagsStore');
const { readCrmState } = require('../src/tenantCrmStore');
const { getLeadStageMap } = require('../src/tenantFunnelStore');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map(JSON.stringify).join('\n')}\n`);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-phase8-service-'));
  const dataDir = path.join(root, 'data');
  const tenant = path.join(dataDir, 'panel');
  writeJsonl(path.join(tenant, 'leads.jsonl'), [
    { id: 'lead-a', nome: 'Ana', email: 'ana@example.invalid', whatsapp_raw: '+55 11 99999-1111', whatsapp_digits: '5511999991111', createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'lead-b', nome: 'Bruno', empresa: 'Empresa B', whatsapp_raw: '+55 11 99999-2222', whatsapp_digits: '5511999992222', createdAt: '2024-01-02T00:00:00.000Z' },
  ]);
  writeJson(path.join(tenant, 'lead_tags.json'), { 'lead-a': ['tag-a'], 'lead-b': ['tag-b'] });
  writeJson(path.join(tenant, 'tags.json'), [{ id: 'tag-a', name: 'A' }, { id: 'tag-b', name: 'B' }]);
  writeJson(path.join(tenant, 'crm.json'), {
    version: 1,
    activePipelineId: 'p',
    pipelines: [{ id: 'p', stageOrder: ['s'], stages: { s: { id: 's', leadIds: ['lead-a', 'lead-b'] } } }],
  });
  writeJson(path.join(tenant, 'funnel_lead_stage.json'), { 'lead-a': 'new', 'lead-b': 'proposal' });
  return { root, dataDir };
}
function actor() { return { auth: { userId: 'panel:operator', role: 'operator' } }; }

function serial(name, fn) {
  test(name, { concurrency: false }, () => {
    const previous = process.env.ZAPE_DATA_DIR;
    const { root, dataDir } = fixture();
    process.env.ZAPE_DATA_DIR = dataDir;
    try { fn(); }
    finally {
      if (previous === undefined) delete process.env.ZAPE_DATA_DIR; else process.env.ZAPE_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

serial('edição mantém ID, tags, CRM e registra histórico anterior e novo', () => {
  const before = publicLead(readLeads('panel').find((lead) => lead.id === 'lead-a'));
  const result = updateLead('panel', 'lead-a', {
    _version: before._version,
    nome: 'Ana Atualizada',
    email: 'ana.nova@example.invalid',
    whatsapp: '+55 11 99999-1111',
    website: 'https://example.invalid',
  }, actor());
  assert.equal(result.lead.id, 'lead-a');
  assert.equal(result.lead.nome, 'Ana Atualizada');
  assert.deepEqual(getLeadTagsMap('panel')['lead-a'], ['tag-a']);
  assert.deepEqual(readCrmState('panel').pipelines[0].stages.s.leadIds, ['lead-a', 'lead-b']);
  const history = fs.readFileSync(path.join(process.env.ZAPE_DATA_DIR, 'panel', 'lead_changes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(history.length, 1);
  assert.equal(history[0].type, 'update');
  assert.equal(history[0].changes.some((change) => change.field === 'nome' && change.previous === 'Ana' && change.next === 'Ana Atualizada'), true);
  assert.equal(history[0].actor.userIdHash.length, 64);
});

serial('versão desatualizada bloqueia concorrência com HTTP lógico 409', () => {
  assert.throws(() => updateLead('panel', 'lead-a', { _version: 'stale', nome: 'Outro' }, actor()), (error) => {
    assert.equal(error instanceof LeadServiceError, true);
    assert.equal(error.code, 'LEAD_VERSION_CONFLICT');
    assert.equal(error.statusCode, 409);
    return true;
  });
});

serial('alterar para telefone existente retorna conflito e não sobrescreve', () => {
  const before = publicLead(readLeads('panel').find((lead) => lead.id === 'lead-a'));
  assert.throws(() => updateLead('panel', 'lead-a', {
    _version: before._version,
    nome: 'Ana',
    whatsapp: '+55 11 99999-2222',
    email: 'ana@example.invalid',
  }, actor()), (error) => {
    assert.equal(error.code, 'LEAD_PHONE_CONFLICT');
    assert.equal(error.statusCode, 409);
    assert.equal(error.details.mergeAvailable, true);
    assert.equal(error.details.conflictLeadId, 'lead-b');
    return true;
  });
  assert.equal(readLeads('panel').length, 2);
});

serial('merge explícito consolida tags e referências do CRM e do funil', () => {
  const leads = readLeads('panel');
  const target = publicLead(leads.find((lead) => lead.id === 'lead-b'));
  const source = publicLead(leads.find((lead) => lead.id === 'lead-a'));
  const result = mergeLeads('panel', 'lead-b', {
    sourceLeadId: 'lead-a',
    targetVersion: target._version,
    sourceVersion: source._version,
    desiredPhone: '+55 11 99999-2222',
    confirm: 'MERGE_LEADS',
  }, actor());
  assert.equal(result.lead.id, 'lead-b');
  assert.deepEqual(new Set(getLeadTagsMap('panel')['lead-b']), new Set(['tag-a', 'tag-b']));
  assert.equal(Object.hasOwn(getLeadTagsMap('panel'), 'lead-a'), false);
  assert.deepEqual(readCrmState('panel').pipelines[0].stages.s.leadIds, ['lead-b']);
  assert.equal(Object.hasOwn(getLeadStageMap('panel'), 'lead-a'), false);
  assert.equal(readLeads('panel').length, 1);
  assert.deepEqual(result.lead.mergedLeadIds, ['lead-a']);
  assert.equal(Array.isArray(result.lead.mergedFieldAlternates.nome), true);
  assert.equal(result.lead.mergedFieldAlternates.nome.includes('Ana'), true);
  assert.equal(result.lead.mergeHistory[0].sourceLeadId, 'lead-a');
});

serial('merge exige confirmação literal', () => {
  const leads = readLeads('panel');
  assert.throws(() => mergeLeads('panel', 'lead-b', {
    sourceLeadId: 'lead-a',
    targetVersion: publicLead(leads[0])._version,
    sourceVersion: publicLead(leads[1])._version,
  }, actor()), /Confirmação explícita/);
});
