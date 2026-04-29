const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureTenantDir, tenantDir } = require("./tenantPaths");

function filePath(tenantId) {
  return path.join(tenantDir(tenantId), "tags.json");
}

function loadAll(tenantId) {
  ensureTenantDir(tenantId);
  const fp = filePath(tenantId);
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = fs.readFileSync(fp, "utf-8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveAll(tenantId, tags) {
  ensureTenantDir(tenantId);
  fs.writeFileSync(filePath(tenantId), JSON.stringify(tags, null, 2), "utf-8");
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

function listTags(tenantId) {
  const tags = loadAll(tenantId);
  tags.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return tags;
}

function upsertTag(tenantId, { id, name, color }) {
  const nm = String(name || "").trim();
  if (!nm) throw new Error("Tag inválida: nome obrigatório.");

  const tags = loadAll(tenantId);
  const c = normalizeColor(color);

  const existsByName = tags.find(
    (t) => String(t.name || "").toLowerCase() === nm.toLowerCase() && String(t.id) !== String(id || "")
  );
  if (existsByName) throw new Error("Já existe uma tag com esse nome.");

  if (id) {
    const idx = tags.findIndex((t) => String(t.id) === String(id));
    if (idx === -1) throw new Error("Tag não encontrada.");
    tags[idx] = { ...tags[idx], name: nm, color: c, updatedAt: new Date().toISOString() };
    saveAll(tenantId, tags);
    return tags[idx];
  }

  const tag = { id: genId(), name: nm, color: c, createdAt: new Date().toISOString() };
  tags.push(tag);
  saveAll(tenantId, tags);
  return tag;
}

function deleteTag(tenantId, id) {
  const tags = loadAll(tenantId);
  const next = tags.filter((t) => String(t.id) !== String(id));
  saveAll(tenantId, next);
  return { ok: true };
}

module.exports = { listTags, upsertTag, deleteTag, normalizeColor };
