'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensureTenantDir } = require('./tenantPaths');

const FILE_NAME = 'forms.json';
const MAX_FORMS = 100;
const MAX_FIELDS = 40;
const MAX_BUTTON_OPTIONS = 20;

function fileFor(tenantId) { return path.join(ensureTenantDir(tenantId), FILE_NAME); }
function clean(v, max = 500) { return String(v == null ? '' : v).trim().slice(0, max); }
function bool(v, fallback = false) { return v == null ? fallback : Boolean(v); }
function safeColor(v, fallback) { const s = clean(v, 32); return /^#[0-9a-f]{3,8}$/i.test(s) ? s : fallback; }
function safeFieldType(v) { return ['text','email','tel','url','number','select','textarea','checkbox','hidden','buttons'].includes(v) ? v : 'text'; }
function safeMapping(v) {
  const s = clean(v, 80);
  return ['nome','empresa','jaAnuncia','website','email','whatsapp','tags'].includes(s) || /^custom\.[a-z0-9_-]{1,50}$/i.test(s) ? s : 'custom.campo';
}
function safeRedirectUrl(v) {
  const s = clean(v, 1200);
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || /^\/(?!\/)/.test(s)) return s;
  return '';
}
function normalizeButtonOption(option, index) {
  return {
    id: clean(option?.id, 80) || `option_${index + 1}_${crypto.randomBytes(3).toString('hex')}`,
    label: clean(option?.label, 120) || `Opção ${index + 1}`,
    url: safeRedirectUrl(option?.url),
  };
}
function normalizeField(field, index) {
  const type = safeFieldType(field?.type);
  return {
    id: clean(field?.id, 80) || `field_${index + 1}_${crypto.randomBytes(3).toString('hex')}`,
    type,
    label: clean(field?.label, 120) || `Campo ${index + 1}`,
    placeholder: clean(field?.placeholder, 180),
    mapping: safeMapping(field?.mapping),
    required: type === 'hidden' ? false : bool(field?.required, false),
    options: Array.isArray(field?.options) ? field.options.map((x) => clean(x, 120)).filter(Boolean).slice(0, 30) : [],
    buttonOptions: type === 'buttons' && Array.isArray(field?.buttonOptions)
      ? field.buttonOptions.slice(0, MAX_BUTTON_OPTIONS).map(normalizeButtonOption)
      : [],
    hiddenValue: type === 'hidden' ? clean(field?.hiddenValue, 500) : '',
  };
}
function normalizeForm(input, existing = null) {
  const now = new Date().toISOString();
  const id = clean(existing?.id || input?.id, 100) || `frm_${crypto.randomBytes(12).toString('base64url')}`;
  const fields = (Array.isArray(input?.fields) ? input.fields : []).slice(0, MAX_FIELDS).map(normalizeField);
  return {
    id,
    name: clean(input?.name, 120) || 'Novo formulário',
    active: bool(input?.active, true),
    fields,
    submitLabel: clean(input?.submitLabel, 80) || 'QUERO SABER MAIS',
    successMessage: clean(input?.successMessage, 300) || 'Obrigado! Recebemos seus dados.',
    redirectUrl: clean(input?.redirectUrl, 1200),
    sourceDetail: clean(input?.sourceDetail, 200) || 'Formulário criado no Zape',
    captureUtm: bool(input?.captureUtm, true),
    style: {
      background: safeColor(input?.style?.background, '#f3f4f6'),
      text: safeColor(input?.style?.text, '#111827'),
      inputBackground: safeColor(input?.style?.inputBackground, '#ffffff'),
      inputBorder: safeColor(input?.style?.inputBorder, '#9ca3af'),
      buttonBackground: safeColor(input?.style?.buttonBackground, '#4f7fc4'),
      buttonText: safeColor(input?.style?.buttonText, '#ffffff'),
      width: Math.max(280, Math.min(1200, Number(input?.style?.width) || 600)),
      radius: Math.max(0, Math.min(32, Number(input?.style?.radius) || 0)),
      spacing: Math.max(6, Math.min(40, Number(input?.style?.spacing) || 14)),
      fontSize: Math.max(12, Math.min(28, Number(input?.style?.fontSize) || 16)),
      padding: Math.max(0, Math.min(64, Number(input?.style?.padding) || 20)),
      labelSize: Math.max(12, Math.min(28, Number(input?.style?.labelSize) || 14)),
      buttonWidth: Math.max(80, Math.min(320, Number(input?.style?.buttonWidth) || 112)),
      buttonRadius: Math.max(0, Math.min(32, Number(input?.style?.buttonRadius) || 10)),
      blockRadius: Math.max(0, Math.min(40, Number(input?.style?.blockRadius) || 18)),
    },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}
function readAll(tenantId) {
  try { const data = JSON.parse(fs.readFileSync(fileFor(tenantId), 'utf8')); return Array.isArray(data?.items) ? data.items : []; }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function writeAll(tenantId, items) {
  const file = fileFor(tenantId); const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function listForms(tenantId) { return readAll(tenantId).map((f) => ({ ...f, submissionCount: Number(f.submissionCount || 0) })); }
function getForm(tenantId, id) { return readAll(tenantId).find((f) => f.id === String(id)) || null; }
function saveForm(tenantId, input) {
  const items = readAll(tenantId); const idx = items.findIndex((f) => f.id === String(input?.id || ''));
  if (idx < 0 && items.length >= MAX_FORMS) { const e = new Error('Limite de formulários atingido.'); e.statusCode = 409; throw e; }
  const next = normalizeForm(input, idx >= 0 ? items[idx] : null);
  if (idx >= 0) items[idx] = { ...items[idx], ...next }; else items.unshift(next);
  writeAll(tenantId, items); return next;
}
function deleteForm(tenantId, id) { const items = readAll(tenantId); const next = items.filter((f) => f.id !== String(id)); if (next.length === items.length) return false; writeAll(tenantId, next); return true; }
function incrementSubmission(tenantId, id) { const items = readAll(tenantId); const idx = items.findIndex((f) => f.id === String(id)); if (idx < 0) return; items[idx].submissionCount = Number(items[idx].submissionCount || 0) + 1; items[idx].lastSubmissionAt = new Date().toISOString(); writeAll(tenantId, items); }

module.exports = { listForms, getForm, saveForm, deleteForm, incrementSubmission, normalizeForm };
