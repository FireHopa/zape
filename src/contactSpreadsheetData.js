'use strict';

// All source values remain strings: phones, IDs and user input are not formulas.
const crypto = require('node:crypto');
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'];
const HEADERS = [
  'ID do contato', 'Cadastro (UTC)', 'Atualizado (UTC)', 'Nome', 'Empresa',
  'J\u00e1 anuncia', 'Website', 'E-mail', 'WhatsApp', 'Origem', 'Detalhe da origem',
  'Tags', 'ID ActiveCampaign', 'S\u00e9rie ActiveCampaign', 'ID do formul\u00e1rio',
  'Formul\u00e1rio', 'ID do webhook', 'Webhook', ...UTM_KEYS,
];
const SOURCE_LABELS = Object.freeze({
  activecampaign: 'ActiveCampaign', generated_webhook_activecampaign: 'ActiveCampaign (webhook)',
  generated_webhook: 'Webhook', zape_form: 'Formul\u00e1rio do site', form: 'Formul\u00e1rio do site',
  manual: 'Cadastro manual', conversation_register: 'Conversa',
});
function text(value) {
  if (value == null) return '';
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : '';
  if (Array.isArray(value)) return value.map(text).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function customData(lead) {
  const value = lead?.sourceMeta?.formData;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function buildContactTable(leads) {
  if (!Array.isArray(leads)) throw new Error('SPREADSHEET_INVALID_SOURCE');
  const unique = new Map();
  for (const lead of leads) {
    if (!lead || typeof lead !== 'object' || !String(lead.id || '').trim()) {
      throw Object.assign(new Error('Cadastro sem ID; verifique a integridade dos leads.'), { code: 'SPREADSHEET_INVALID_SOURCE' });
    }
    const id = String(lead.id);
    const previous = unique.get(id);
    if (!previous || text(lead.updatedAt || lead.createdAt) > text(previous.updatedAt || previous.createdAt)) unique.set(id, lead);
  }
  const items = [...unique.values()].sort((a, b) =>
    text(a.createdAt).localeCompare(text(b.createdAt)) || text(a.id).localeCompare(text(b.id)));
  const customKeys = [...new Set(items.flatMap((lead) => Object.keys(customData(lead))))].sort();
  const headers = [...HEADERS, ...customKeys.map((key) => `Campo: ${key}`)];
  const rows = items.map((lead) => {
    const meta = lead.sourceMeta || {};
    return [
      lead.id, lead.createdAt, lead.updatedAt, lead.nome, lead.empresa, lead.jaAnuncia,
      lead.website, lead.email, lead.whatsapp_digits || lead.whatsapp_raw || lead.whatsapp,
      SOURCE_LABELS[lead.source] || lead.source, lead.sourceDetail, lead.tags,
      lead.active_contact_id, lead.active_seriesid, meta.formId, meta.formName,
      meta.webhookId, meta.webhookName,
      ...UTM_KEYS.map((key) => meta.utm?.[key]),
      ...customKeys.map((key) => customData(lead)[key]),
    ].map(text);
  });
  const values = [headers, ...rows];
  const hash = crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
  return { headers, values, count: rows.length, hash };
}
function csvCell(value) {
  let result = text(value);
  // Quoting alone does NOT stop spreadsheet formula injection.
  if (/^[\s\uFEFF]*[=+@-]/u.test(result) || /^[\t\r\n]/.test(result)) result = `'${result}`;
  return `"${result.replace(/"/g, '""')}"`;
}
function tableToCsv(table) {
  return '\uFEFF' + table.values.map((row) => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
function columnName(index) {
  let result = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}
module.exports = { buildContactTable, tableToCsv, csvCell, columnName, HEADERS };
