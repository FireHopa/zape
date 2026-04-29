// src/messageStatusStore.js
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "message_status.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveAll(obj) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), "utf-8");
}

/**
 * Key = toDigits (ex: 5511999999999)
 * Value = status object
 */
function upsert(toDigits, patch) {
  const all = loadAll();
  const prev = all[toDigits] || { toDigits };
  const next = { ...prev, ...patch, toDigits, updatedAt: new Date().toISOString() };
  all[toDigits] = next;
  saveAll(all);
  return next;
}

function get(toDigits) {
  const all = loadAll();
  return all[toDigits] || null;
}

function list() {
  const all = loadAll();
  return Object.values(all);
}

function computeStats({ notDeliveredAfterMs }) {
  const rows = list();
  const now = Date.now();

  let replied = 0;
  let deliveredNoReply = 0;
  let notDelivered = 0;
  let notOnWhatsapp = 0;

  for (const r of rows) {
    if (r.notOnWhatsapp) {
      notOnWhatsapp++;
      continue;
    }

    if (!r.lastSendAt) continue;

    if (r.repliedAt) {
      replied++;
      continue;
    }

    const ack = Number.isFinite(r.ack) ? r.ack : -1;

    if (ack >= 2) {
      deliveredNoReply++;
      continue;
    }

    const age = now - new Date(r.lastSendAt).getTime();
    if (age >= notDeliveredAfterMs) notDelivered++;
  }

  return {
    replied,
    deliveredNoReply,
    notDelivered,
    notOnWhatsapp,
    totalTracked: rows.length,
  };
}

module.exports = { upsert, get, list, computeStats };
