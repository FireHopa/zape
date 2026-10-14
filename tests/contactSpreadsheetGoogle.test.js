'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGoogleMirror, googleConfig, OWNER_KEY } = require('../src/contactSpreadsheetGoogle');
const { buildContactTable } = require('../src/contactSpreadsheetData');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function harness(t, { sheets = [], failWrite = 0, responseCode = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-google-sheet-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'test-account.json');
  const account = { type: 'service_account', client_email: 'test@project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://attacker.invalid/token' };
  fs.writeFileSync(file, JSON.stringify(account), { mode: 0o600 });
  const env = { CONTACT_SPREADSHEET_GOOGLE_ID_ADMIN: 'spreadsheet123456', CONTACT_SPREADSHEET_GOOGLE_CREDENTIALS: file };
  const config = googleConfig('admin', env);
  const requests = [], writes = [], cells = new Map();
  let writeCount = 0;
  function response(status, body) { return { ok: status < 300, status, json: async () => body }; }
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://oauth2.googleapis.com/token') {
      const assertion = new URLSearchParams(options.body).get('assertion');
      const [header, claims, signature] = assertion.split('.');
      assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
      assert.equal(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')), true);
      const payload = JSON.parse(Buffer.from(claims, 'base64url'));
      assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
      assert.equal(payload.scope, 'https://www.googleapis.com/auth/spreadsheets');
      assert.ok(payload.exp - payload.iat <= 3600);
      return response(200, { access_token: 'FAKE_TOKEN_FOR_TEST_ONLY', expires_in: 3600 });
    }
    assert.ok(url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/spreadsheet123456'));
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer FAKE_TOKEN_FOR_TEST_ONLY');
    if (responseCode) return response(responseCode, { error: { message: 'sensitive raw response' } });
    if (options.method === 'GET') return response(200, { sheets });
    if (options.method === 'PUT') {
      writeCount += 1;
      const body = JSON.parse(options.body);
      writes.push(body); assert.ok(url.includes('valueInputOption=RAW'));
      const start = Number(body.range.match(/!A(\d+)/)[1]);
      // Simulate commit-before-response-loss: server applies data, client sees 503.
      body.values.forEach((row, index) => cells.set(start + index, row));
      if (writeCount === failWrite) return response(503, { error: { message: 'timeout after commit' } });
      return response(200, {});
    }
    const body = JSON.parse(options.body);
    for (const request of body.requests || []) {
      if (request.addSheet) sheets.push({ properties: request.addSheet.properties, developerMetadata: [] });
      if (request.createDeveloperMetadata) {
        const meta = request.createDeveloperMetadata.developerMetadata;
        sheets.find((sheet) => sheet.properties.sheetId === meta.location.sheetId).developerMetadata.push(meta);
      }
      if (request.updateSheetProperties) {
        const props = request.updateSheetProperties.properties;
        Object.assign(sheets.find((sheet) => sheet.properties.sheetId === props.sheetId).properties.gridProperties, props.gridProperties);
      }
    }
    return response(200, {});
  };
  const mirror = createGoogleMirror({ fetchImpl, throttleMs: 0, wait: async () => {} });
  return { mirror, config, requests, writes, sheets, cells, file };
}
const table = (count = 1) => buildContactTable(Array.from({ length: count }, (_, index) => ({
  id: String(index).padStart(5, '0'), nome: index === 0 ? '=1+1' : `Name ${index}`,
  whatsapp_digits: '5511999990001', source: 'manual', createdAt: '2026-10-14',
})));

test('configuration is per tenant, accepts Google URL and never implicitly exports all accounts', () => {
  const env = { CONTACT_SPREADSHEET_GOOGLE_IDS: JSON.stringify({ admin: 'https://docs.google.com/spreadsheets/d/abc_1234567890/edit#gid=0' }), CONTACT_SPREADSHEET_GOOGLE_CREDENTIALS: '/secret.json' };
  assert.equal(googleConfig('admin', env).spreadsheetId, 'abc_1234567890');
  assert.equal(googleConfig('panel', env).enabled, false);
  assert.ok(googleConfig('admin', { CONTACT_SPREADSHEET_GOOGLE_ID_ADMIN: 'https://evil.invalid/x' }).error);
  assert.ok(googleConfig('admin', { CONTACT_SPREADSHEET_GOOGLE_IDS: 'bad-json' }).error);
});

test('signed JWT uses fixed Google endpoint, RAW writes preserve phones and formula-like text', async (t) => {
  const h = harness(t); const result = await h.mirror.sync(h.config, 'admin', table());
  assert.equal(h.sheets.length, 1); assert.equal(h.sheets[0].developerMetadata[0].metadataKey, OWNER_KEY);
  assert.equal(h.writes[0].values[1][3], '=1+1'); assert.equal(h.writes[0].values[1][8], '5511999990001');
  assert.ok(result.url.includes('#gid='));
  assert.ok(h.requests.every((request) => !request.url.includes('attacker')));
  await h.mirror.sync(h.config, 'admin', table());
  assert.equal(h.sheets.length, 1); assert.equal(h.cells.size, 2);
  assert.equal(h.requests.filter((request) => request.url.includes('oauth2.googleapis.com')).length, 1);
});

test('does not overwrite a pre-existing unowned tab with the same name', async (t) => {
  const h = harness(t, { sheets: [{ properties: { sheetId: 42, title: 'Zape - admin', gridProperties: { rowCount: 100, columnCount: 26 } }, developerMetadata: [] }] });
  const result = await h.mirror.sync(h.config, 'admin', table());
  assert.equal(result.title, 'Zape - admin (2)'); assert.equal(h.sheets.length, 2);
  assert.notEqual(result.sheetId, 42);
  assert.ok(h.writes.every((write) => write.range.startsWith("'Zape - admin (2)'!")));
});

test('chunks large batches, then clears stale rows only after acknowledged writes', async (t) => {
  const h = harness(t, { sheets: [{ properties: { sheetId: 42, title: 'Managed', gridProperties: { rowCount: 1400, columnCount: 35 } }, developerMetadata: [{ metadataKey: OWNER_KEY, metadataValue: 'admin' }] }] });
  await h.mirror.sync(h.config, 'admin', table(1001));
  assert.equal(h.writes.length, 3);
  assert.ok(h.writes[0].range.includes('!A1:')); assert.ok(h.writes[1].range.includes('!A501:')); assert.ok(h.writes[2].range.includes('!A1001:'));
  const last = JSON.parse(h.requests.at(-1).options.body);
  assert.equal(last.requests[0].updateCells.range.startRowIndex, 1002);
  assert.equal(last.requests[0].updateCells.fields, 'userEnteredValue');
});

test('retries after a lost response update the same ranges without duplicated contacts', async (t) => {
  const h = harness(t, { failWrite: 2 });
  await assert.rejects(h.mirror.sync(h.config, 'admin', table(600)), { code: 'GOOGLE_SHEETS_503' });
  const last = h.requests.at(-1); assert.equal(last.options.method, 'PUT');
  await h.mirror.sync(h.config, 'admin', table(600));
  assert.equal(h.sheets.length, 1); assert.equal(h.cells.size, 601);
  assert.deepEqual([...h.cells.values()].slice(1).map((row) => row[0]), table(600).values.slice(1).map((row) => row[0]));
});

test('Google error messages never include response bodies or credentials', async (t) => {
  const h = harness(t, { responseCode: 403 });
  await assert.rejects(h.mirror.sync(h.config, 'admin', table()), (error) => {
    assert.equal(error.code, 'GOOGLE_SHEETS_403');
    assert.ok(!error.message.includes('sensitive')); assert.ok(!error.message.includes('FAKE_TOKEN')); return true;
  });
});

test('oversized cells fail visibly before changing spreadsheet data', async (t) => {
  const h = harness(t); const large = table(); large.values[1][3] = 'x'.repeat(50001);
  await assert.rejects(h.mirror.sync(h.config, 'admin', large), { code: 'GOOGLE_CELL_TOO_LONG' });
  assert.equal(h.writes.length, 0);
});

test('invalid or missing service-account JSON is not sent anywhere', async (t) => {
  const h = harness(t); fs.writeFileSync(h.file, '{}');
  await assert.rejects(h.mirror.sync(h.config, 'admin', table()), { code: 'GOOGLE_CREDENTIALS_INVALID' });
  assert.equal(h.requests.length, 0);
});
