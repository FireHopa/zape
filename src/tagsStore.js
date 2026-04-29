// src/tagsStore.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "tags.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(FILE)) return [];
  try {
    const raw = fs.readFileSync(FILE, "utf-8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveAll(tags) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(tags, null, 2), "utf-8");
}

function genId() {
  return crypto.randomBytes(8).toString("hex");
}

function normalizeColor(hex) {
  const s = String(hex || "").trim();
  if (!s) return "#111827";
  const m = s.match(/^#?[0-9a-fA-F]{6}$/);
  if (!m) return "#111827";
  return s.startsWith("#") ? s.toLowerCase() : ("#" + s.toLowerCase());
}

function listTags() {
  const tags = loadAll();
  // ordena por nome
  tags.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return tags;
}

function upsertTag({ id, name, color }) {
  const nm = String(name || "").trim();
  if (!nm) throw new Error("Tag inválida: nome obrigatório.");

  const tags = loadAll();
  const c = normalizeColor(color);

  // nome único (case-insensitive)
  const existsByName = tags.find(
    (t) => String(t.name || "").toLowerCase() === nm.toLowerCase() && String(t.id) !== String(id || "")
  );
  if (existsByName) throw new Error("Já existe uma tag com esse nome.");

  if (id) {
    const idx = tags.findIndex((t) => String(t.id) === String(id));
    if (idx === -1) throw new Error("Tag não encontrada.");
    tags[idx] = { ...tags[idx], name: nm, color: c, updatedAt: new Date().toISOString() };
    saveAll(tags);
    return tags[idx];
  }

  const tag = { id: genId(), name: nm, color: c, createdAt: new Date().toISOString() };
  tags.push(tag);
  saveAll(tags);
  return tag;
}

function deleteTag(id) {
  const tags = loadAll();
  const next = tags.filter((t) => String(t.id) !== String(id));
  saveAll(next);
  return { ok: true };
}

module.exports = { listTags, upsertTag, deleteTag, normalizeColor };
