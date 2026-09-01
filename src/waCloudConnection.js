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


function configuredAllowedPhoneNumberIds(config = {}) {
  const allowed = new Set();
  const runtimePhone = cleanId(config.phoneNumberId);
  if (runtimePhone) allowed.add(runtimePhone);
  for (const item of cleanId(process.env.WA_CLOUD_ALLOWED_PHONE_NUMBER_IDS).split(',')) {
    const id = cleanId(item);
    if (id) allowed.add(id);
  }
  const rawMap = cleanId(process.env.WA_CLOUD_PHONE_TENANT_MAP);
  if (rawMap) {
    try {
      if (rawMap.startsWith('{')) {
        for (const id of Object.keys(JSON.parse(rawMap) || {})) {
          const cleanPhone = cleanId(id);
          if (cleanPhone) allowed.add(cleanPhone);
        }
      } else {
        for (const item of rawMap.split(',')) {
          const separator = item.includes('=') ? '=' : ':';
          const id = cleanId(item.split(separator, 1)[0]);
          if (id) allowed.add(id);
        }
      }
    } catch (error) {
      const wrapped = new Error('WA_CLOUD_PHONE_TENANT_MAP contém JSON inválido.');
      wrapped.code = 'WA_CLOUD_PHONE_TENANT_MAP_INVALID';
      wrapped.cause = error;
      throw wrapped;
    }
  }
  return allowed;
}

function assertWebhookMatchesConnection(body, config = {}) {
  const expected = connectionFromRuntimeConfig(config);
  if (!expected.wabaId) {
    const error = new Error('A conexão da Cloud API está incompleta.');
    error.code = 'META_CONNECTION_INCOMPLETE';
    error.status = 503;
    throw error;
  }
  const incoming = extractWebhookConnectionIds(body);
  const allowedPhoneNumberIds = configuredAllowedPhoneNumberIds(config);
  if (incoming.phoneNumberIds.length !== 1 || !allowedPhoneNumberIds.has(incoming.phoneNumberIds[0])) {
    const error = new Error('O webhook recebido não pertence a um Phone Number ID autorizado.');
    error.code = 'META_PHONE_NUMBER_MISMATCH';
    error.status = 403;
    error.details = { receivedCount: incoming.phoneNumberIds.length, allowedCount: allowedPhoneNumberIds.size };
    throw error;
  }
  if (incoming.wabaIds.length && (incoming.wabaIds.length !== 1 || incoming.wabaIds[0] !== expected.wabaId)) {
    const error = new Error('O webhook recebido não pertence ao WABA configurado.');
    error.code = 'META_WABA_MISMATCH';
    error.status = 403;
    error.details = { expectedWabaId: expected.wabaId, receivedCount: incoming.wabaIds.length };
    throw error;
  }
  const phoneNumberId = incoming.phoneNumberIds[0];
  const wabaId = incoming.wabaIds[0] || expected.wabaId;
  return {
    ...expected,
    phoneNumberId,
    wabaId,
    connectionId: buildConnectionId({ phoneNumberId, wabaId }),
  };
}

module.exports = {
  buildConnectionId,
  getConnectionOwnerTenant,
  configuredAllowedPhoneNumberIds,
  connectionFromRuntimeConfig,
  extractWebhookConnectionIds,
  assertWebhookMatchesConnection,
};
