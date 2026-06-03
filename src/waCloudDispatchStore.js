// src/waCloudDispatchStore.js
// Histórico seguro de disparos oficiais. Não altera leads antigos.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "wa_cloud_dispatches.json");

function ensureDir(){ if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function now(){ return new Date().toISOString(); }
function genId(prefix){ return `${prefix || "id"}_${crypto.randomBytes(10).toString("hex")}`; }
function normalizeDigits(value){ return String(value || "").replace(/\D+/g, "").replace(/^0+/, ""); }
function readStore(){
  ensureDir();
  if (!fs.existsSync(FILE)) return { version: 1, campaigns: [], events: [] };
  try{
    const raw = JSON.parse(fs.readFileSync(FILE, "utf-8")) || {};
    return {
      version: Number(raw.version || 1),
      campaigns: Array.isArray(raw.campaigns) ? raw.campaigns : [],
      events: Array.isArray(raw.events) ? raw.events : [],
    };
  }catch(_){ return { version: 1, campaigns: [], events: [] }; }
}
function writeStore(store){
  ensureDir();
  const safe = {
    version: 1,
    campaigns: Array.isArray(store && store.campaigns) ? store.campaigns : [],
    events: Array.isArray(store && store.events) ? store.events : [],
  };
  fs.writeFileSync(FILE, JSON.stringify(safe, null, 2), "utf-8");
  return safe;
}
function createCampaign(input = {}){
  const store = readStore();
  const createdAt = input.createdAt || now();
  const campaign = {
    id: input.id || genId("camp"),
    tenantId: String(input.tenantId || "admin"),
    name: String(input.name || input.templateName || "Campanha oficial").trim(),
    templateName: String(input.templateName || "").trim(),
    languageCode: String(input.languageCode || "pt_BR").trim(),
    total: Number(input.total || 0),
    sourceSummary: input.sourceSummary && typeof input.sourceSummary === "object" ? input.sourceSummary : {},
    createdAt,
    updatedAt: createdAt,
  };
  store.campaigns.push(campaign);
  writeStore(store);
  return campaign;
}
function recordEvent(input = {}){
  const store = readStore();
  const createdAt = input.createdAt || now();
  const event = {
    id: input.id || genId("evt"),
    tenantId: String(input.tenantId || "admin"),
    campaignId: String(input.campaignId || ""),
    campaignName: String(input.campaignName || "").trim(),
    templateName: String(input.templateName || "").trim(),
    languageCode: String(input.languageCode || "pt_BR").trim(),
    toDigits: normalizeDigits(input.toDigits || input.to || input.phone),
    leadId: input.leadId ? String(input.leadId) : "",
    leadSnapshot: input.leadSnapshot && typeof input.leadSnapshot === "object" ? input.leadSnapshot : null,
    origin: input.origin && typeof input.origin === "object" ? input.origin : null,
    dispatchSource: input.dispatchSource && typeof input.dispatchSource === "object" ? input.dispatchSource : null,
    vars: Array.isArray(input.vars) ? input.vars.map((x) => String(x ?? "")) : [],
    status: String(input.status || "pending"),
    deliveryState: String(input.deliveryState || ""),
    messageId: input.messageId || null,
    error: input.error || null,
    sentAt: input.sentAt || null,
    deliveredAt: input.deliveredAt || null,
    readAt: input.readAt || null,
    failedAt: input.failedAt || null,
    respondedAt: input.respondedAt || null,
    inbound: input.inbound || null,
    createdAt,
    updatedAt: createdAt,
  };
  store.events.push(event);
  writeStore(store);
  return event;
}
function updateEvent(eventId, patch = {}){
  if (!eventId) return null;
  const store = readStore();
  const idx = store.events.findIndex((e) => String(e.id) === String(eventId));
  if (idx < 0) return null;
  const prev = store.events[idx];
  const next = { ...prev, ...patch, id: prev.id, updatedAt: now() };
  store.events[idx] = next;
  if (next.campaignId) {
    const camp = store.campaigns.find((c) => String(c.id) === String(next.campaignId));
    if (camp) camp.updatedAt = next.updatedAt;
  }
  writeStore(store);
  return next;
}
function updateByMessageId(messageId, patch = {}){
  const id = String(messageId || "").trim();
  if (!id) return null;
  const store = readStore();
  let changed = null;
  for (let i = store.events.length - 1; i >= 0; i--) {
    const ev = store.events[i];
    if (String(ev.messageId || "") !== id) continue;
    const nextPatch = { ...patch };
    if (ev.status === "responded" && patch.status && patch.status !== "failed") {
      delete nextPatch.status;
    }
    store.events[i] = { ...ev, ...nextPatch, updatedAt: now() };
    changed = store.events[i];
    break;
  }
  if (changed && changed.campaignId) {
    const camp = store.campaigns.find((c) => String(c.id) === String(changed.campaignId));
    if (camp) camp.updatedAt = changed.updatedAt;
  }
  if (changed) writeStore(store);
  return changed;
}
function markReply(fromDigits, patch = {}, options = {}){
  const digits = normalizeDigits(fromDigits);
  if (!digits) return null;
  const windowMs = Math.max(1, Number(options.windowMs || 7 * 24 * 60 * 60 * 1000));
  const tNow = Date.now();
  const store = readStore();
  let bestIndex = -1;
  let bestTime = 0;
  for (let i = 0; i < store.events.length; i++) {
    const ev = store.events[i];
    if (normalizeDigits(ev.toDigits) !== digits) continue;
    if (String(ev.status || "") === "failed") continue;
    const baseTime = new Date(ev.sentAt || ev.createdAt || 0).getTime();
    if (!baseTime || tNow - baseTime > windowMs) continue;
    if (baseTime >= bestTime) { bestTime = baseTime; bestIndex = i; }
  }
  if (bestIndex < 0) return null;
  const prev = store.events[bestIndex];
  const respondedAt = patch.respondedAt || now();
  const next = {
    ...prev,
    status: "responded",
    respondedAt,
    inbound: patch.inbound || prev.inbound || null,
    updatedAt: respondedAt,
  };
  store.events[bestIndex] = next;
  if (next.campaignId) {
    const camp = store.campaigns.find((c) => String(c.id) === String(next.campaignId));
    if (camp) camp.updatedAt = next.updatedAt;
  }
  writeStore(store);
  return next;
}
function listCampaigns(tenantId){
  const tid = tenantId ? String(tenantId) : "";
  const store = readStore();
  return store.campaigns.filter((c) => !tid || String(c.tenantId || "admin") === tid);
}
function listEvents(tenantId){
  const tid = tenantId ? String(tenantId) : "";
  const store = readStore();
  return store.events.filter((e) => !tid || String(e.tenantId || "admin") === tid);
}
module.exports = { createCampaign, recordEvent, updateEvent, updateByMessageId, markReply, listCampaigns, listEvents, readStore, writeStore };
