const fs = require("fs");
const path = require("path");
const { ensureTenantDir, tenantDir } = require("./tenantPaths");

function filePath(tenantId) {
  return path.join(tenantDir(tenantId), "lead_tags.json");
}

function loadAll(tenantId) {
  ensureTenantDir(tenantId);
  const fp = filePath(tenantId);
  if (!fs.existsSync(fp)) return {};
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8")) || {};
  } catch {
    return {};
  }
}

function saveAll(tenantId, obj) {
  ensureTenantDir(tenantId);
  fs.writeFileSync(filePath(tenantId), JSON.stringify(obj, null, 2), "utf-8");
}

function getLeadTagsMap(tenantId) {
  return loadAll(tenantId);
}

function setLeadTags(tenantId, leadId, tagIds) {
  const id = String(leadId || "").trim();
  if (!id) throw new Error("leadId inválido.");

  const arr = Array.isArray(tagIds) ? tagIds : [];
  const cleaned = [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];

  const all = loadAll(tenantId);
  all[id] = cleaned;
  saveAll(tenantId, all);
  return { leadId: id, tagIds: cleaned };
}

function removeTagFromAllLeads(tenantId, tagId) {
  const tid = String(tagId || "").trim();
  if (!tid) return { ok: true };

  const all = loadAll(tenantId);
  let changed = false;

  for (const [leadId, ids] of Object.entries(all)) {
    if (!Array.isArray(ids)) continue;
    const next = ids.filter((x) => String(x) !== tid);
    if (next.length !== ids.length) {
      all[leadId] = next;
      changed = true;
    }
  }

  if (changed) saveAll(tenantId, all);
  return { ok: true, changed };
}

function removeLeadTags(tenantId, leadId) {
  const id = String(leadId || "").trim();
  if (!id) return { ok: true, changed: false };

  const all = loadAll(tenantId);
  if (!Object.prototype.hasOwnProperty.call(all, id)) {
    return { ok: true, changed: false };
  }

  delete all[id];
  saveAll(tenantId, all);
  return { ok: true, changed: true };
}

module.exports = { getLeadTagsMap, setLeadTags, removeTagFromAllLeads, removeLeadTags };
