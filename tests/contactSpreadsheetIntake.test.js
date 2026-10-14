'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLeadFromPayload } = require('../src/leadIntakeService');
const { contactSpreadsheet, readCurrentLeads } = require('../src/contactSpreadsheet');
const { buildContactTable } = require('../src/contactSpreadsheetData');
const { registerFormRoutes } = require('../src/routes/tenant/formRoutes');
const { registerContactSpreadsheetRoutes } = require('../src/routes/tenant/contactSpreadsheetRoutes');
const { saveForm } = require('../src/formBuilderStore');
const { readLeads } = require('../src/tenantLeadsStore');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function response() {
  return { statusCode: 200, headers: {}, payload: null, status(code) { this.statusCode = code; return this; }, setHeader(name, value) { this.headers[name] = value; }, type() { return this; }, send(value) { this.payload = value; return this; }, json(value) { this.payload = value; return this; } };
}
function fakeRouter() {
  const handlers = new Map(); const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) app[method] = (url, ...chain) => handlers.set(`${method}:${url}`, chain);
  return { app, handlers };
}
function inTemp(name, fn) {
  test(name, { concurrency: false }, async () => {
    const previous = { ...process.env };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-sheet-intake-'));
    process.env.ZAPE_DATA_DIR = root; process.env.PERSISTENCE_MODE = 'json';
    try { await fn(root); }
    finally {
      await contactSpreadsheet.stop();
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous); fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

inTemp('accepted ActiveCampaign and manual contacts automatically reach the CSV', async () => {
  contactSpreadsheet.start();
  await createLeadFromPayload('admin', 'activecampaign', { nome: 'Active lead', email: 'active@example.invalid', whatsapp: '+55 11 99999-0001', active_contact_id: '123' });
  await createLeadFromPayload('admin', 'manual', { nome: 'Manual lead', email: 'manual@example.invalid' }, { allowEmailOnly: true });
  for (let i = 0; i < 100 && contactSpreadsheet.status('admin').count !== 2; i += 1) await wait(10);
  assert.equal(contactSpreadsheet.status('admin').count, 2);
  const csv = fs.readFileSync(contactSpreadsheet.files('admin').csv, 'utf8');
  assert.ok(csv.includes('Active lead')); assert.ok(csv.includes('Manual lead')); assert.ok(csv.includes('"123"'));
});

inTemp('actual form submit handler writes custom selection, UTM and email-only lead to the mirror', async () => {
  const { app, handlers } = fakeRouter(); registerFormRoutes(app, { tenantId: 'panel', authMiddleware: (_req, _res, next) => next() });
  const form = saveForm('panel', { name: 'Website', active: true, fields: [
    { id: 'name', label: 'Nome', type: 'text', mapping: 'nome', required: true },
    { id: 'email', label: 'Email', type: 'email', mapping: 'email', required: true },
    { id: 'choice', label: 'Cidade', type: 'buttons', mapping: 'custom.cidade', buttonOptions: [{ id: 'op1', label: 'Londrina', url: '/obrigado' }] },
  ] });
  const submit = handlers.get('post:/forms/panel/:id/submit').at(-1);
  const res = response();
  await submit({ params: { id: form.id }, body: { f_name: 'Lead Form', f_email: 'form@example.invalid', f_choice: 'op1', utm_source: 'campaign' } }, res);
  assert.equal(res.statusCode, 200); assert.equal(readLeads('panel').length, 1);
  const table = buildContactTable(await readCurrentLeads('panel'));
  assert.equal(table.values[1][table.headers.indexOf('Campo: cidade')], 'Londrina');
  const out = await contactSpreadsheet.download('panel');
  assert.ok(out.csv.includes('Website')); assert.ok(out.csv.includes('campaign')); assert.ok(out.csv.includes('Londrina'));
});

inTemp('concurrent duplicate submissions keep a single contact and single spreadsheet row', async () => {
  const input = { nome: 'One contact', email: 'one@example.invalid', whatsapp: '+55 11 99999-4444' };
  const outcomes = await Promise.allSettled(Array.from({ length: 15 }, () => createLeadFromPayload('regina', 'activecampaign', input)));
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal((await contactSpreadsheet.download('regina')).count, 1);
});

inTemp('local mirror errors do not undo an accepted lead or break intake', async (root) => {
  const directory = path.join(root, 'ana'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'contact_spreadsheet'), 'not a directory');
  const saved = await createLeadFromPayload('ana', 'manual', { nome: 'Keep me', email: 'keep@example.invalid' }, { allowEmailOnly: true });
  await assert.rejects(contactSpreadsheet.syncTenant('ana'));
  assert.equal(readLeads('ana')[0].id, saved.id);
});

inTemp('corrupt source blocks mirror replacement rather than silently exporting partial data', async (root) => {
  await createLeadFromPayload('portugal', 'manual', { nome: 'Keep me', email: 'keep@example.invalid' }, { allowEmailOnly: true });
  await contactSpreadsheet.syncTenant('portugal');
  const original = fs.readFileSync(contactSpreadsheet.files('portugal').csv);
  fs.appendFileSync(path.join(root, 'portugal', 'leads.jsonl'), 'not-json\n');
  await assert.rejects(contactSpreadsheet.syncTenant('portugal'), { code: 'SPREADSHEET_SOURCE_CORRUPT' });
  assert.deepEqual(fs.readFileSync(contactSpreadsheet.files('portugal').csv), original);
});

inTemp('download route is authenticated, tenant-scoped and ignores list pagination/filters', async () => {
  await createLeadFromPayload('admin', 'manual', { nome: 'A', email: 'a@example.invalid' }, { allowEmailOnly: true });
  await createLeadFromPayload('admin', 'manual', { nome: 'B', email: 'b@example.invalid' }, { allowEmailOnly: true });
  const { app, handlers } = fakeRouter(); const auth = () => {}; const audits = [];
  registerContactSpreadsheetRoutes(app, { tenantId: 'admin', authMiddleware: auth, auditSecurityAction: (...args) => audits.push(args) });
  assert.equal(handlers.size, 3);
  for (const chain of handlers.values()) assert.equal(chain[0], auth);
  const res = response();
  await handlers.get('get:/api/admin/contact-spreadsheet/download').at(-1)({ query: { page: 1, pageSize: 1, q: 'A', tenantId: 'panel' } }, res);
  assert.equal(res.headers['Cache-Control'], 'no-store'); assert.ok(res.headers['Content-Disposition'].includes('contatos_admin.csv'));
  assert.ok(res.payload.includes('a@example.invalid')); assert.ok(res.payload.includes('b@example.invalid')); assert.equal(audits[0].at(-1).total, 2);
});
