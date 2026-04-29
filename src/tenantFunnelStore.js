const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureTenantDir } = require("./tenantPaths");

function genId() {
  return crypto.randomBytes(10).toString("hex");
}

function stagesPath(tenantId) {
  return path.join(ensureTenantDir(tenantId), "funnel_stages.json");
}

function mapPath(tenantId) {
  return path.join(ensureTenantDir(tenantId), "funnel_lead_stage.json");
}

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, data) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

function defaultStages() {
  // ÚNICA etapa padrão. As demais o usuário cria.
  return [
    { id: "new", name: "Novos", color: "#1a73e8", locked: true, order: 0 },
  ];
}

function normalizeStages(stages) {
  const arr = Array.isArray(stages) ? stages : [];
  const hasNew = arr.some((s) => s && s.id === "new");
  const fixed = hasNew ? arr : [...defaultStages(), ...arr];
  // garante propriedades
  const out = fixed
    .filter((s) => s && typeof s === "object" && String(s.id || "").trim())
    .map((s, idx) => ({
      id: String(s.id),
      name: String(s.name || "").trim() || "Etapa",
      color: String(s.color || "").trim() || "#1a73e8",
      locked: s.id === "new" ? true : Boolean(s.locked),
      order: Number.isFinite(Number(s.order)) ? Number(s.order) : idx,
    }));
  // garante "new" primeiro
  out.sort((a, b) => (a.id === "new" ? -1 : b.id === "new" ? 1 : a.order - b.order));
  out.forEach((s, i) => (s.order = i));
  return out;
}

function listStages(tenantId) {
  const p = stagesPath(tenantId);
  const stages = readJsonSafe(p, null);
  const normalized = normalizeStages(stages || defaultStages());
  // se arquivo não existe ou estava inválido, regrava
  if (!fs.existsSync(p)) writeJsonAtomic(p, normalized);
  return normalized;
}

function saveStages(tenantId, stages) {
  const normalized = normalizeStages(stages);
  writeJsonAtomic(stagesPath(tenantId), normalized);
  return normalized;
}

function createStage(tenantId, { name, color } = {}) {
  const stages = listStages(tenantId);
  const st = {
    id: genId(),
    name: String(name || "").trim() || "Nova etapa",
    color: String(color || "").trim() || "#64748b",
    locked: false,
    order: stages.length,
  };
  stages.push(st);
  return saveStages(tenantId, stages);
}

function updateStage(tenantId, id, patch = {}) {
  const stages = listStages(tenantId);
  const idx = stages.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error("Etapa não encontrada.");
  if (stages[idx].id === "new") {
    // permite só cor (nome fica "Novos" pra consistência)
    stages[idx].color = String(patch.color || stages[idx].color);
    stages[idx].name = "Novos";
  } else {
    if (patch.name !== undefined) stages[idx].name = String(patch.name || "").trim() || stages[idx].name;
    if (patch.color !== undefined) stages[idx].color = String(patch.color || "").trim() || stages[idx].color;
  }
  return saveStages(tenantId, stages);
}

function deleteStage(tenantId, id) {
  if (id === "new") throw new Error("A etapa 'Novos' não pode ser removida.");
  const stages = listStages(tenantId);
  const kept = stages.filter((s) => s.id !== id);
  if (kept.length === stages.length) throw new Error("Etapa não encontrada.");
  const normalized = saveStages(tenantId, kept);

  // move leads dessa etapa para "new"
  const map = getLeadStageMap(tenantId);
  let changed = false;
  for (const [leadId, stageId] of Object.entries(map)) {
    if (stageId === id) {
      map[leadId] = "new";
      changed = true;
    }
  }
  if (changed) setLeadStageMap(tenantId, map);

  return normalized;
}

function getLeadStageMap(tenantId) {
  return readJsonSafe(mapPath(tenantId), {});
}

function setLeadStageMap(tenantId, map) {
  const clean = {};
  const m = map && typeof map === "object" ? map : {};
  for (const [k, v] of Object.entries(m)) {
    const leadId = String(k || "").trim();
    const stageId = String(v || "").trim();
    if (leadId && stageId) clean[leadId] = stageId;
  }
  writeJsonAtomic(mapPath(tenantId), clean);
  return clean;
}

function setLeadStage(tenantId, leadId, stageId) {
  const lid = String(leadId || "").trim();
  const sid = String(stageId || "").trim() || "new";
  if (!lid) throw new Error("leadId inválido.");
  const stages = listStages(tenantId);
  const exists = stages.some((s) => s.id === sid);
  if (!exists) throw new Error("stageId inválido.");
  const map = getLeadStageMap(tenantId);
  map[lid] = sid;
  setLeadStageMap(tenantId, map);
  return map;
}

module.exports = {
  listStages,
  createStage,
  updateStage,
  deleteStage,
  getLeadStageMap,
  setLeadStage,
};
