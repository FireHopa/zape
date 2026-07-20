'use strict';

const crypto = require('crypto');

function cleanId(value) {
  return String(value || '').trim();
}

function buildConnectionId({ phoneNumberId, wabaId } = {}) {
  const phone = cleanId(phoneNumberId);
  const waba = cleanId(wabaId);
  if (!phone && !waba) return '';
  return `conn_${crypto.createHash('sha256').update(`${phone}:${waba}`).digest('hex').slice(0, 24)}`;
}

function getConnectionOwnerTenant() {
  const owner = cleanId(process.env.WA_CLOUD_CONNECTION_OWNER_TENANT || 'admin').toLowerCase() || 'admin';
  const allowed = new Set(['admin', 'panel', 'regina', 'portugal', 'felipe', 'ana']);
  if (!allowed.has(owner)) {
    const error = new Error('WA_CLOUD_CONNECTION_OWNER_TENANT inválido.');
    error.code = 'WA_CLOUD_CONNECTION_OWNER_INVALID';
    throw error;
  }
  return owner;
}

function connectionFromRuntimeConfig(config = {}) {
  const phoneNumberId = cleanId(config.phoneNumberId);
  const wabaId = cleanId(config.wabaId);
  return {
    connectionId: buildConnectionId({ phoneNumberId, wabaId }),
    ownerTenantId: getConnectionOwnerTenant(),
    phoneNumberId,
    wabaId,
    businessId: cleanId(config.businessId),
    graphVersion: cleanId(config.graphVersion || 'v25.0'),
  };
}

function extractWebhookConnectionIds(body = {}) {
  const phoneNumberIds = new Set();
  const wabaIds = new Set();
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    const entryWabaId = cleanId(entry && entry.id);
    if (entryWabaId) wabaIds.add(entryWabaId);
    for (const change of Array.isArray(entry && entry.changes) ? entry.changes : []) {
      const value = change && change.value ? change.value : {};
      const phoneNumberId = cleanId(value?.metadata?.phone_number_id);
      if (phoneNumberId) phoneNumberIds.add(phoneNumberId);
    }
  }
  return {
    phoneNumberIds: [...phoneNumberIds],
    wabaIds: [...wabaIds],
  };
}

function assertWebhookMatchesConnection(body, config = {}) {
  const expected = connectionFromRuntimeConfig(config);
  if (!expected.phoneNumberId || !expected.wabaId || !expected.connectionId) {
    const error = new Error('A conexão da Cloud API está incompleta.');
    error.code = 'META_CONNECTION_INCOMPLETE';
    error.status = 503;
    throw error;
  }
  const incoming = extractWebhookConnectionIds(body);
  if (incoming.phoneNumberIds.length !== 1 || incoming.phoneNumberIds[0] !== expected.phoneNumberId) {
    const error = new Error('O webhook recebido não pertence ao Phone Number ID configurado.');
    error.code = 'META_PHONE_NUMBER_MISMATCH';
    error.status = 403;
    error.details = { expectedPhoneNumberId: expected.phoneNumberId, receivedCount: incoming.phoneNumberIds.length };
    throw error;
  }
  if (incoming.wabaIds.length && (incoming.wabaIds.length !== 1 || incoming.wabaIds[0] !== expected.wabaId)) {
    const error = new Error('O webhook recebido não pertence ao WABA configurado.');
    error.code = 'META_WABA_MISMATCH';
    error.status = 403;
    error.details = { expectedWabaId: expected.wabaId, receivedCount: incoming.wabaIds.length };
    throw error;
  }
  return expected;
}

module.exports = {
  buildConnectionId,
  getConnectionOwnerTenant,
  connectionFromRuntimeConfig,
  extractWebhookConnectionIds,
  assertWebhookMatchesConnection,
};
