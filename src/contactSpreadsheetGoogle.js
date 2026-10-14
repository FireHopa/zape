'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { columnName } = require('./contactSpreadsheetData');
const OWNER_KEY = 'zape_contact_mirror_v1';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function googleError(code, message) { return Object.assign(new Error(message), { code }); }
function googleConfig(tenantId, env = process.env) {
  const key = String(tenantId).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  let raw = String(env[`CONTACT_SPREADSHEET_GOOGLE_ID_${key}`] || '').trim();
  try {
    const map = JSON.parse(env.CONTACT_SPREADSHEET_GOOGLE_IDS || '{}');
    if (Object.prototype.hasOwnProperty.call(map, tenantId)) raw = String(map[tenantId] || '').trim();
  } catch {
    return { enabled: true, error: 'CONTACT_SPREADSHEET_GOOGLE_IDS precisa conter JSON v\u00e1lido.' };
  }
  if (!raw) return { enabled: false };
  const urlMatch = raw.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/);
  const spreadsheetId = urlMatch ? urlMatch[1] : raw;
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(spreadsheetId)) return { enabled: true, error: 'ID da planilha Google inv\u00e1lido.' };
  const credentialsFile = String(env.CONTACT_SPREADSHEET_GOOGLE_CREDENTIALS || '').trim();
  if (!credentialsFile) return { enabled: true, error: 'Configure CONTACT_SPREADSHEET_GOOGLE_CREDENTIALS no servidor.' };
  return { enabled: true, spreadsheetId, credentialsFile, title: `Zape - ${tenantId}`, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` };
}

function createGoogleMirror({ fetchImpl = globalThis.fetch, wait = delay, throttleMs = 1100 } = {}) {
  const tokens = new Map();
  let tail = Promise.resolve();
  let lastRequestAt = 0;

  async function requestJson(url, options, errorCode) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
    } catch {
      throw googleError(errorCode, 'N\u00e3o foi poss\u00edvel conectar ao Google. Uma nova tentativa ser\u00e1 feita automaticamente.');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Do not log response bodies, JWTs, access tokens, private keys or contact data.
      const advice = response.status === 403 ? 'Ative a API Google Sheets e compartilhe a planilha com a conta de servi\u00e7o como Editora.'
        : response.status === 404 ? 'Verifique o ID e o compartilhamento da planilha.'
          : response.status === 429 ? 'Limite do Google atingido; a sincroniza\u00e7\u00e3o ser\u00e1 repetida.'
            : 'Verifique a configura\u00e7\u00e3o; a sincroniza\u00e7\u00e3o ser\u00e1 repetida.';
      throw googleError(`${errorCode}_${response.status}`, `Google HTTP ${response.status}. ${advice}`);
    }
    return body;
  }

  async function accessToken(file) {
    let account, stat;
    try {
      stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 65536) throw new Error('invalid_file');
      account = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (account.type !== 'service_account' || !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(account.client_email || '') || !account.private_key) throw new Error('invalid_account');
    } catch {
      throw googleError('GOOGLE_CREDENTIALS_INVALID', 'Arquivo da conta de servi\u00e7o ausente, ileg\u00edvel ou inv\u00e1lido.');
    }
    const fingerprint = crypto.createHash('sha256').update(account.private_key).update(account.client_email).digest('hex');
    const cached = tokens.get(file);
    if (cached?.fingerprint === fingerprint && cached.expiresAt > Date.now() + 60000) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    // Always use Google's fixed token endpoint. Never trust token_uri from a JSON file.
    const claims = Buffer.from(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })).toString('base64url');
    const unsigned = `${header}.${claims}`;
    let signature;
    try { signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url'); }
    catch { throw googleError('GOOGLE_CREDENTIALS_INVALID', 'Chave privada da conta de servi\u00e7o inv\u00e1lida.'); }
    const result = await requestJson(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
    }, 'GOOGLE_AUTH');
    if (!result.access_token) throw googleError('GOOGLE_AUTH_INVALID', 'O Google n\u00e3o retornou um token de acesso.');
    tokens.set(file, { fingerprint, token: result.access_token, expiresAt: Date.now() + Math.min(Number(result.expires_in) || 3600, 3600) * 1000 });
    return result.access_token;
  }

  async function sync(config, tenantId, table) {
    if (config.error) throw googleError('GOOGLE_CONFIG_INVALID', config.error);
    const token = await accessToken(config.credentialsFile);
    const base = API + encodeURIComponent(config.spreadsheetId);
    async function api(suffix, method = 'GET', body) {
      await wait(Math.max(0, throttleMs - (Date.now() - lastRequestAt)));
      lastRequestAt = Date.now();
      try {
        return await requestJson(base + suffix, {
          method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }, 'GOOGLE_SHEETS');
      } catch (error) {
        if (error.code === 'GOOGLE_SHEETS_401') tokens.delete(config.credentialsFile);
        throw error;
      }
    }
    for (const row of table.values) {
      if (row.some((cell) => cell.length > 50000)) throw googleError('GOOGLE_CELL_TOO_LONG', 'Um campo excede 50.000 caracteres. O CSV local mant\u00e9m o conte\u00fado completo.');
    }
    const doc = await api('?fields=sheets(properties,developerMetadata)');
    const sheets = Array.isArray(doc.sheets) ? doc.sheets : [];
    let sheet = sheets.find((item) => (item.developerMetadata || []).some((meta) => meta.metadataKey === OWNER_KEY && meta.metadataValue === tenantId));
    if (!sheet) {
      // A pre-existing unmarked tab is never overwritten, even when its title matches.
      let title = config.title;
      for (let index = 2; sheets.some((item) => item.properties?.title === title); index += 1) title = `${config.title} (${index})`;
      let sheetId = crypto.randomInt(1, 2147483647);
      while (sheets.some((item) => item.properties?.sheetId === sheetId)) sheetId = crypto.randomInt(1, 2147483647);
      const properties = { sheetId, title, gridProperties: { rowCount: Math.max(table.values.length, 100), columnCount: Math.max(table.headers.length, 26), frozenRowCount: 1 } };
      await api(':batchUpdate', 'POST', { requests: [
        { addSheet: { properties } },
        { createDeveloperMetadata: { developerMetadata: { metadataKey: OWNER_KEY, metadataValue: tenantId, location: { sheetId }, visibility: 'DOCUMENT' } } },
      ] });
      sheet = { properties };
    }
    const props = sheet.properties;
    const sheetId = props.sheetId;
    const rowCount = Math.max(Number(props.gridProperties?.rowCount) || 1, table.values.length);
    const columnCount = Math.max(Number(props.gridProperties?.columnCount) || 1, table.headers.length);
    if (rowCount !== props.gridProperties?.rowCount || columnCount !== props.gridProperties?.columnCount) {
      await api(':batchUpdate', 'POST', { requests: [{ updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount, columnCount } }, fields: 'gridProperties.rowCount,gridProperties.columnCount' } }] });
    }
    const quotedTitle = `'${props.title.replace(/'/g, "''")}'`;
    // Fixed ranges + RAW values are idempotent after timeouts; never append blindly.
    for (let offset = 0; offset < table.values.length;) {
      const chunk = []; let size = 0;
      while (offset + chunk.length < table.values.length && chunk.length < 500) {
        const row = table.values[offset + chunk.length];
        const bytes = Buffer.byteLength(JSON.stringify(row));
        if (chunk.length && size + bytes > 750000) break;
        if (bytes > 1900000) throw googleError('GOOGLE_ROW_TOO_LARGE', 'Uma linha excede o tamanho de envio ao Google. O CSV local permanece completo.');
        chunk.push(row); size += bytes;
      }
      const range = `${quotedTitle}!A${offset + 1}:${columnName(table.headers.length - 1)}${offset + chunk.length}`;
      await api(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, 'PUT', { range, majorDimension: 'ROWS', values: chunk });
      offset += chunk.length;
    }
    // Clear stale rows/columns only AFTER every new chunk was acknowledged.
    const requests = [];
    if (rowCount > table.values.length) requests.push({ updateCells: { range: { sheetId, startRowIndex: table.values.length, endRowIndex: rowCount }, fields: 'userEnteredValue' } });
    if (columnCount > table.headers.length) requests.push({ updateCells: { range: { sheetId, startColumnIndex: table.headers.length, endColumnIndex: columnCount }, fields: 'userEnteredValue' } });
    requests.push(
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, endColumnIndex: table.headers.length }, cell: { userEnteredFormat: { backgroundColor: { red: 0.08, green: 0.18, blue: 0.25 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } }, fields: 'userEnteredFormat' } },
      { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, endRowIndex: table.values.length, startColumnIndex: 0, endColumnIndex: table.headers.length } } } },
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: table.headers.length }, properties: { pixelSize: 180 }, fields: 'pixelSize' } },
    );
    await api(':batchUpdate', 'POST', { requests });
    return { sheetId, title: props.title, url: `${config.url}#gid=${sheetId}` };
  }
  function syncSerialized(config, tenantId, table) {
    const current = tail.then(() => sync(config, tenantId, table));
    tail = current.catch(() => undefined);
    return current;
  }
  return { sync: syncSerialized };
}
module.exports = { createGoogleMirror, googleConfig, OWNER_KEY };
