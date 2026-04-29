// src/leadTagsStore.js
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "lead_tags.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) || {};
  } catch {
    return {};
  }
}

function saveAll(obj) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), "utf-8");
}

function getLeadTagsMap() {
  return loadAll(); // { [leadId]: ["tagId", ...] }
}

function setLeadTags(leadId, tagIds) {
  const id = String(leadId || "").trim();
  if (!id) throw new Error("leadId inválido.");

  const arr = Array.isArray(tagIds) ? tagIds : [];
  const cleaned = [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];

  const all = loadAll();
  all[id] = cleaned;
  saveAll(all);
  return { leadId: id, tagIds: cleaned };
}

// util: remove tagId de todos os leads (quando deletar tag)
function removeTagFromAllLeads(tagId) {
  const tid = String(tagId || "").trim();
  if (!tid) return { ok: true };

  const all = loadAll();
  let changed = false;

  for (const [leadId, ids] of Object.entries(all)) {
    if (!Array.isArray(ids)) continue;
    const next = ids.filter((x) => String(x) !== tid);
    if (next.length !== ids.length) {
      all[leadId] = next;
      changed = true;
    }
  }

  if (changed) saveAll(all);
  return { ok: true, changed };
}

module.exports = { getLeadTagsMap, setLeadTags, removeTagFromAllLeads };
