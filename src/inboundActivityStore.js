'use strict';

const fs = require('fs');
const path = require('path');
const { normalizePhoneToE164Digits } = require('./phone');

const VERSION = 1;

function dataRoot() {
  return process.env.ZAPE_DATA_DIR
    ? path.resolve(process.env.ZAPE_DATA_DIR)
    : path.join(__dirname, '..', 'data');
}

function activityFilePath() {
  const configured = String(process.env.WHATSAPP_INBOUND_ACTIVITY_FILE || '').trim();
  return configured ? path.resolve(configured) : path.join(dataRoot(), 'inbound_lead_activity.json');
}

function emptyStore() {
  return { version: VERSION, items: {} };
}

function activityKey(tenantId, phone) {
  const tenant = String(tenantId || 'admin').trim().toLowerCase() || 'admin';
  const digits = normalizePhoneToE164Digits(phone || '');
  return digits ? `${tenant}:${digits}` : '';
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
}

function readStore() {
  const filePath = activityFilePath();
  if (!fs.existsSync(filePath)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8') || '{}');
    return {
      version: VERSION,
      items: parsed && parsed.items && typeof parsed.items === 'object' ? parsed.items : {},
    };
  } catch (error) {
    const wrapped = new Error('Histórico de atividade inbound indisponível ou corrompido.');
    wrapped.code = 'INBOUND_ACTIVITY_STORE_CORRUPTED';
    wrapped.cause = error;
    throw wrapped;
  }
}

function getInboundActivity(tenantId, phone) {
  const key = activityKey(tenantId, phone);
  if (!key) return null;
  return readStore().items[key] || null;
}

function evaluateInboundActivity({ tenantId, phone, leadId, messageId, channel, receivedAt, reactivationDays = 30 } = {}) {
  const key = activityKey(tenantId, phone);
  if (!key) {
    const error = new Error('Telefone inválido para registrar atividade inbound.');
    error.code = 'INBOUND_ACTIVITY_PHONE_INVALID';
    throw error;
  }

  const at = String(receivedAt || new Date().toISOString());
  const atMs = Date.parse(at);
  const safeAt = Number.isFinite(atMs) ? new Date(atMs).toISOString() : new Date().toISOString();
  const store = readStore();
  const previous = store.items[key] || null;
  const normalizedMessageId = String(messageId || '').trim().slice(0, 255);
  const duplicateMessage = Boolean(previous && normalizedMessageId && previous.lastMessageId === normalizedMessageId);
  const thresholdMs = Math.max(1, Number(reactivationDays || 30)) * 24 * 60 * 60 * 1000;
  const previousAtMs = previous ? Date.parse(previous.lastInboundAt || '') : NaN;
  const reactivated = Boolean(
    previous
    && !duplicateMessage
    && Number.isFinite(previousAtMs)
    && Date.parse(safeAt) - previousAtMs >= thresholdMs
  );

  const current = {
    tenantId: String(tenantId || 'admin').trim().toLowerCase() || 'admin',
    phone: normalizePhoneToE164Digits(phone || ''),
    leadId: String(leadId || previous?.leadId || '').trim(),
    firstInboundAt: previous?.firstInboundAt || safeAt,
    firstMessageId: previous?.firstMessageId || normalizedMessageId,
    lastInboundAt: safeAt,
    previousInboundAt: previous?.lastInboundAt || '',
    lastMessageId: normalizedMessageId || previous?.lastMessageId || '',
    lastChannel: String(channel || previous?.lastChannel || 'whatsapp').trim(),
    inboundCount: Number(previous?.inboundCount || 0) + (duplicateMessage ? 0 : 1),
    reactivationCount: Number(previous?.reactivationCount || 0) + (reactivated ? 1 : 0),
    createdAt: previous?.createdAt || safeAt,
    updatedAt: safeAt,
  };

  return {
    key,
    previous,
    current: duplicateMessage ? previous : current,
    firstSeen: !previous,
    duplicateMessage,
    reactivated,
    gapDays: previous && Number.isFinite(previousAtMs)
      ? Math.floor((Date.parse(safeAt) - previousAtMs) / (24 * 60 * 60 * 1000))
      : null,
  };
}

function commitInboundActivity(evaluation) {
  if (!evaluation || !evaluation.key || evaluation.duplicateMessage) return evaluation;
  const store = readStore();
  const latest = store.items[evaluation.key] || null;
  const latestAt = Date.parse(latest?.lastInboundAt || '');
  const incomingAt = Date.parse(evaluation.current?.lastInboundAt || '');
  if (Number.isFinite(latestAt) && Number.isFinite(incomingAt) && latestAt > incomingAt) {
    return { ...evaluation, current: latest, superseded: true };
  }
  store.items[evaluation.key] = evaluation.current;
  atomicWriteJson(activityFilePath(), store);
  return evaluation;
}

function recordInboundActivity(input = {}) {
  return commitInboundActivity(evaluateInboundActivity(input));
}

module.exports = {
  VERSION,
  activityFilePath,
  activityKey,
  commitInboundActivity,
  evaluateInboundActivity,
  getInboundActivity,
  readStore,
  recordInboundActivity,
};
