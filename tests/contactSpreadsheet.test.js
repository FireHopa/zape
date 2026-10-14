'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildContactTable, tableToCsv, csvCell, columnName } = require('../src/contactSpreadsheetData');
const { createContactSpreadsheetService, readCurrentLeads } = require('../src/contactSpreadsheet');
const { permissionForTenantRequest, PERMISSIONS, hasPermission } = require('../src/authorization');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lead = (id, source = 'activecampaign', extra = {}) => ({ id, source, nome: `Nome ${id}`, createdAt: '2026-10-14T00:00:00.000Z', whatsapp_digits: '5511999990001', ...extra });
const logger = { error() {} };

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-contact-sheet-'));
  const data = { admin: [], panel: [] };
  const service = createContactSpreadsheetService({ readLeads: async (tenant) => data[tenant] || [], listTenants: () => Object.keys(data), directory: (tenant) => path.join(root, tenant), env: {}, logger, ...options });
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, data, service };
}

test('table includes ActiveCampaign, custom form fields, UTM, Unicode and IDs as text', () => {
  const result = buildContactTable([lead('1', 'generated_webhook_activecampaign', { active_contact_id: '000123', active_seriesid: 'series' }), lead('2', 'zape_form', {
    nome: 'Jo\u00e3o', email: 'mail@example.invalid', whatsapp_digits: '', sourceMeta: { formId: 'f', formName: 'Contato', formData: { bairro: 'Centro', escolha: 'Op\u00e7\u00e3o A' }, utm: { utm_source: 'Google' } },
  })]);
  assert.equal(result.count, 2);
  assert.equal(result.values[1][12], '000123');
  assert.equal(result.values[2][3], 'Jo\u00e3o');
  assert.equal(result.values[2][18], 'Google');
  assert.equal(result.values[2][result.headers.indexOf('Campo: bairro')], 'Centro');
  assert.equal(result.values[2][result.headers.indexOf('Campo: escolha')], 'Op\u00e7\u00e3o A');
  assert.equal(result.values[2][8], '');
  assert.equal(buildContactTable([lead('pg', 'manual', { createdAt: new Date('2026-10-14T00:00:00Z') })]).values[1][1], '2026-10-14T00:00:00.000Z');
});

test('one row per saved ID, deterministic order, latest version wins', () => {
  const data = [lead('b'), lead('a'), lead('a', 'manual', { nome: 'Atualizado', updatedAt: '2026-10-15' })];
  const table = buildContactTable(data);
  assert.equal(table.count, 2);
  assert.deepEqual(table.values.slice(1).map((row) => row[0]), ['a', 'b']);
  assert.equal(table.values[1][3], 'Atualizado');
  assert.equal(table.hash, buildContactTable([...data].reverse()).hash);
  assert.equal(data.length, 3);
});

test('CSV quotes delimiters, multiline text, accents and mitigates formula injection', () => {
  assert.equal(csvCell('a;"b"\nc'), '"a;""b""\nc"');
  for (const value of ['=1+1', '+SUM(A1)', '-1+2', '@SUM(A1)', '  =cmd()', '\t=1', '\r=2']) {
    assert.ok(csvCell(value).startsWith('"\''), value);
  }
  const table = buildContactTable([lead('1', 'form', { nome: '=IMPORTXML("x")' })]);
  assert.equal(table.values[1][3], '=IMPORTXML("x")');
  assert.ok(tableToCsv(table).startsWith('\uFEFF'));
  assert.ok(tableToCsv(table).includes('"\'=IMPORTXML'));
  assert.ok(tableToCsv(table).endsWith('\r\n'));
});

test('rejects invalid source rather than silently dropping contacts', () => {
  assert.throws(() => buildContactTable([{}]), { code: 'SPREADSHEET_INVALID_SOURCE' });
  assert.throws(() => buildContactTable(null));
  assert.equal(buildContactTable([]).count, 0);
  assert.equal(columnName(0), 'A'); assert.equal(columnName(25), 'Z'); assert.equal(columnName(26), 'AA');
});

test('backfills existing contacts, includes new origins, does not duplicate on recheck', async (t) => {
  const { data, service } = fixture(t);
  data.admin = [lead('existing'), lead('form', 'zape_form'), lead('manual', 'manual')];
  await service.syncTenant('admin');
  const before = fs.readFileSync(service.files('admin').csv, 'utf8');
  await service.syncTenant('admin');
  assert.equal(fs.readFileSync(service.files('admin').csv, 'utf8'), before);
  assert.equal(service.status('admin').count, 3);
  data.admin.push(lead('new'));
  const downloaded = await service.download('admin');
  assert.equal(downloaded.count, 4);
  assert.ok(downloaded.csv.includes('"new"'));
  assert.equal(fs.statSync(service.files('admin').csv).mode & 0o777, 0o600);
});

test('edits, merges and deletions are reflected in the current mirror', async (t) => {
  const { data, service } = fixture(t);
  data.admin = [lead('1'), lead('2')]; await service.syncTenant('admin');
  data.admin = [lead('1', 'manual', { nome: 'Editado' })];
  await service.syncTenant('admin');
  let out = await service.download('admin');
  assert.equal(out.count, 1); assert.ok(out.csv.includes('Editado')); assert.ok(!out.csv.includes('Nome 2'));
  data.admin = []; out = await service.download('admin'); assert.equal(out.count, 0);
});

test('separate files and content for each tenant', async (t) => {
  const { data, service } = fixture(t);
  data.admin = [lead('secret-admin')]; data.panel = [lead('secret-panel')];
  await Promise.all([service.syncTenant('admin'), service.syncTenant('panel')]);
  const a = await service.download('admin'), b = await service.download('panel');
  assert.ok(!a.csv.includes('secret-panel')); assert.ok(!b.csv.includes('secret-admin'));
  assert.throws(() => service.files('../admin'));
});

test('derived CSV is repaired after deletion or manual corruption', async (t) => {
  const { data, service } = fixture(t); data.admin = [lead('repair')];
  await service.syncTenant('admin'); const original = fs.readFileSync(service.files('admin').csv, 'utf8');
  fs.writeFileSync(service.files('admin').csv, 'wrong'); await service.syncTenant('admin');
  assert.equal(fs.readFileSync(service.files('admin').csv, 'utf8'), original);
  fs.unlinkSync(service.files('admin').csv); await service.syncTenant('admin');
  assert.equal(fs.readFileSync(service.files('admin').csv, 'utf8'), original);
});

test('restart rebuilds the snapshot from durable contacts, not a transient queue', async (t) => {
  const { data, root, service } = fixture(t); data.admin = [lead('old')]; await service.syncTenant('admin');
  data.admin.push(lead('created-while-offline'));
  fs.writeFileSync(service.files('admin').state, 'corrupted json');
  const restarted = createContactSpreadsheetService({ readLeads: async () => data.admin, directory: (tenant) => path.join(root, tenant), env: {}, logger });
  await restarted.syncTenant('admin');
  assert.equal(restarted.status('admin').count, 2); await restarted.stop();
});

test('a source read failure preserves the previous CSV and displays an error', async (t) => {
  let fails = false;
  const { service } = fixture(t, { readLeads: async () => { if (fails) throw new Error('database unavailable'); return [lead('safe')]; } });
  await service.syncTenant('admin'); const before = fs.readFileSync(service.files('admin').csv);
  fails = true; await assert.rejects(service.syncTenant('admin'));
  assert.deepEqual(fs.readFileSync(service.files('admin').csv), before);
  assert.equal(service.status('admin').local.error.code, 'SPREADSHEET_LOCAL_FAILED');
});

test('Google failure does not block the local copy; status exposes retry without secrets', async (t) => {
  const { data, service } = fixture(t, { env: { CONTACT_SPREADSHEET_GOOGLE_ID_ADMIN: 'sheet_id_123456', CONTACT_SPREADSHEET_GOOGLE_CREDENTIALS: '/secret/account.json' }, google: { sync: async () => { throw Object.assign(new Error('quota'), { code: 'GOOGLE_SHEETS_429' }); } } });
  data.admin = [lead('local-first')];
  await service.syncTenant('admin', { waitForGoogle: true });
  assert.equal(service.status('admin').local.ready, true);
  assert.equal(service.status('admin').google.state, 'error');
  assert.ok(service.status('admin').google.nextAttemptAt);
  assert.ok(!JSON.stringify(service.status('admin')).includes('/secret/'));
  assert.equal((await service.download('admin')).count, 1);
});

test('a blocked network request does not prevent a later local contact being saved', async (t) => {
  let finish;
  const blocked = new Promise((resolve) => { finish = resolve; });
  const { data, service } = fixture(t, { env: { CONTACT_SPREADSHEET_GOOGLE_ID_ADMIN: 'sheet_id_123456', CONTACT_SPREADSHEET_GOOGLE_CREDENTIALS: '/account.json' }, google: { sync: () => blocked } });
  data.admin = [lead('before')]; await service.syncTenant('admin');
  data.admin.push(lead('during-network-outage')); await service.syncTenant('admin');
  assert.equal(service.status('admin').count, 2);
  finish({ url: 'https://docs.google.com/spreadsheets/d/sheet_id_123456/edit#gid=1', title: 'Zape - admin' });
  await wait(5);
  assert.equal(service.status('admin').google.state, 'pending');
});

test('worker reconciles on startup and schedules without any browser open', async (t) => {
  const { data, service } = fixture(t); data.admin = [lead('startup')]; service.start();
  for (let i = 0; i < 50 && service.status('admin').count !== 1; i += 1) await wait(10);
  assert.equal(service.status('admin').count, 1);
  data.admin.push(lead('scheduled')); service.schedule('admin', 0);
  for (let i = 0; i < 50 && service.status('admin').count !== 2; i += 1) await wait(10);
  assert.equal(service.status('admin').count, 2);
});

test('disabled service performs no writes and does not download stale personal data', async (t) => {
  const { service } = fixture(t, { env: { CONTACT_SPREADSHEET_ENABLED: '0' } });
  service.start(); await service.syncTenant('admin');
  assert.equal(fs.existsSync(service.files('admin').csv), false);
  await assert.rejects(service.download('admin'), { code: 'SPREADSHEET_DISABLED' });
});

test('API policies require export permission, including the external sheet link', () => {
  for (const [method, suffix] of [['GET', ''], ['GET', '/download'], ['POST', '/sync']]) {
    const permission = permissionForTenantRequest({ method, path: `/api/admin/contact-spreadsheet${suffix}` }, 'admin');
    assert.equal(permission, PERMISSIONS.LEADS_EXPORT);
    assert.equal(hasPermission({ role: 'viewer', permissions: [PERMISSIONS.LEADS_READ] }, permission), false);
  }
});

test('database mode reads the authoritative repository, not stale JSON or lead cache', async () => {
  const runtime = require('../src/database/runtime'); const state = runtime.getState();
  const previous = { config: state.config, initialized: state.initialized, leadRepository: state.leadRepository };
  const pages = [];
  try {
    state.config = { mode: 'database' }; state.initialized = true;
    state.leadRepository = { async list(tenantId, options) {
      assert.equal(tenantId, 'admin'); pages.push(options.page);
      return { items: options.page === 1 ? [{ id: 'live', nome: 'Authoritative', payload: {}, phoneNormalized: '5511999990002' }] : [], hasNext: options.page === 1 };
    } };
    const rows = await readCurrentLeads('admin');
    assert.equal(rows.length, 1); assert.equal(rows[0].nome, 'Authoritative'); assert.deepEqual(pages, [1, 2]);
    state.initialized = false; await assert.rejects(readCurrentLeads('admin'), { code: 'SPREADSHEET_DATABASE_UNAVAILABLE' });
  } finally { Object.assign(state, previous); }
});
