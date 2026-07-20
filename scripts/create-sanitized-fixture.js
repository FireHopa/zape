#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}
function assertSafeTarget(target, force) {
  if (!fs.existsSync(target)) return;
  const entries = fs.readdirSync(target);
  if (entries.length && !force) {
    throw new Error(`Destino não está vazio: ${target}. Use --force somente em diretório descartável.`);
  }
  if (force) fs.rmSync(target, { recursive: true, force: true });
}

const tenants = ['admin', 'panel', 'regina', 'portugal', 'felipe', 'ana'];
const output = path.resolve(process.cwd(), readArg('output', 'tmp/sanitized-fixture/data'));
const force = process.argv.includes('--force');
assertSafeTarget(output, force);
fs.mkdirSync(output, { recursive: true });

const now = '2026-01-01T12:00:00.000Z';
for (let index = 0; index < tenants.length; index += 1) {
  const tenant = tenants[index];
  const tenantDir = path.join(output, tenant);
  const leadId = `fixture-${tenant}-lead-1`;
  const phone = `15555550${String(101 + index).padStart(3, '0')}`;
  const lead = {
    id: leadId,
    source: 'synthetic_fixture',
    sourceDetail: 'Dado sintético gerado para teste',
    sourceMeta: { type: 'fixture', synthetic: true },
    createdAt: now,
    nome: `Pessoa Teste ${index + 1}`,
    empresa: `Empresa Teste ${tenant}`,
    jaAnuncia: 'Não',
    website: 'https://example.invalid',
    email: `teste+${tenant}@example.invalid`,
    whatsapp_raw: phone,
    whatsapp_digits: phone,
    tags: 'fixture',
    active_contact_id: '',
    active_seriesid: '',
  };
  writeJsonl(path.join(tenantDir, 'leads.jsonl'), [lead]);
  writeJson(path.join(tenantDir, 'tags.json'), [{ id: 'tag-fixture', name: 'Fixture', color: '#777777' }]);
  writeJson(path.join(tenantDir, 'lead_tags.json'), { [leadId]: ['tag-fixture'] });
  writeJson(path.join(tenantDir, 'crm.json'), {
    version: 1,
    pipelines: [{ id: 'pipeline-fixture', name: 'Pipeline de Teste', stages: [{ id: 'stage-fixture', name: 'Entrada', leadIds: [leadId] }] }],
  });
  writeJson(path.join(tenantDir, 'message_status.json'), {});
  writeJson(path.join(tenantDir, 'messageTemplate.json'), { text: 'Olá, {{nome}}. Esta é uma mensagem sintética.' });
  writeJson(path.join(tenantDir, 'conversations.json'), {
    [phone]: [{ id: `fixture-message-${tenant}`, fromMe: false, body: 'Mensagem sintética de teste', type: 'chat', timestamp: 1767268800, createdAt: now, ack: null, source: 'fixture' }],
  });
  writeJson(path.join(tenantDir, 'wa_cloud_saved_sheets.json'), []);
  fs.mkdirSync(path.join(tenantDir, 'conversation_media'), { recursive: true });
  if (tenant === 'admin') {
    writeJson(path.join(tenantDir, 'businessOwner.json'), {
      name: 'Responsável Teste',
      email: 'responsavel@example.invalid',
      company: 'Empresa Sintética',
    });
  }
}

writeJson(path.join(output, 'webhooks.json'), []);
writeJson(path.join(output, 'external_crm_queue.json'), []);
writeJson(path.join(output, 'wa_cloud_dispatches.json'), { version: 1, campaigns: [], events: [] });
writeJson(path.join(output, 'wa_cloud_message_status.json'), {});
writeJson(path.join(output, 'wa_cloud_config.json'), {
  schemaVersion: 2,
  enabled: false,
  graphVersion: 'v25.0',
  phoneNumberId: '000000000000000',
  wabaId: '000000000000000',
  appId: '000000000000000',
  configurationId: '000000000000000',
  updatedAt: now,
  synthetic: true,
});

writeJson(path.join(output, '_fixture_manifest.json'), {
  version: 1,
  synthetic: true,
  generatedAt: new Date().toISOString(),
  tenants,
  containsRealData: false,
  containsMedia: false,
  warning: 'Nunca habilite envios reais com esta fixture.',
});

console.log(JSON.stringify({ ok: true, output, tenants: tenants.length, realData: false, mediaFiles: 0 }, null, 2));
