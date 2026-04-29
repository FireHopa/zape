const fs = require("fs");
const path = require("path");
const { ensureTenantDir, tenantDir } = require("./tenantPaths");

function crmFile(tenantId) {
  return path.join(tenantDir(tenantId), "crm.json");
}

function defaultState() {
  const now = new Date().toISOString();
  const pipelineId = "pipe_main";
  const stages = [
    { id: "stg_new", name: "Novo lead" },
    { id: "stg_contact", name: "Contato" },
    { id: "stg_meeting", name: "Reunião" },
    { id: "stg_proposal", name: "Proposta" },
    { id: "stg_won", name: "Fechou" },
  ];

  const stageMap = {};
  const stageOrder = [];
  for (const s of stages) {
    stageOrder.push(s.id);
    stageMap[s.id] = { id: s.id, name: s.name, leadIds: [] };
  }

  return {
    version: 1,
    activePipelineId: pipelineId,
    pipelines: [
      {
        id: pipelineId,
        name: "Funil Principal",
        createdAt: now,
        stageOrder,
        stages: stageMap,
      },
    ],
    updatedAt: now,
  };
}

function readCrmState(tenantId) {
  ensureTenantDir(tenantId);
  const filePath = crmFile(tenantId);
  if (!fs.existsSync(filePath)) return defaultState();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    // minimal sanity
    if (!parsed || typeof parsed !== "object") return defaultState();
    if (!Array.isArray(parsed.pipelines)) return defaultState();
    return parsed;
  } catch (e) {
    return defaultState();
  }
}

function atomicWriteJSON(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function writeCrmState(tenantId, state) {
  ensureTenantDir(tenantId);
  const filePath = crmFile(tenantId);

  const now = new Date().toISOString();
  const safe = state && typeof state === "object" ? state : defaultState();
  safe.version = 1;
  safe.updatedAt = now;

  // keep activePipelineId valid
  const pipes = Array.isArray(safe.pipelines) ? safe.pipelines : [];
  if (!pipes.length) {
    const d = defaultState();
    atomicWriteJSON(filePath, d);
    return d;
  }
  if (!safe.activePipelineId || !pipes.some((p) => p.id === safe.activePipelineId)) {
    safe.activePipelineId = pipes[0].id;
  }

  // normalize pipeline shape
  for (const p of pipes) {
    p.stages = p.stages && typeof p.stages === "object" ? p.stages : {};
    p.stageOrder = Array.isArray(p.stageOrder) ? p.stageOrder : Object.keys(p.stages);
    // ensure every stage in stageOrder exists
    p.stageOrder = p.stageOrder.filter((id) => p.stages[id]);
    for (const sid of Object.keys(p.stages)) {
      if (!p.stageOrder.includes(sid)) p.stageOrder.push(sid);
      const st = p.stages[sid];
      st.leadIds = Array.isArray(st.leadIds) ? st.leadIds : [];
    }
  }
  safe.pipelines = pipes;

  atomicWriteJSON(filePath, safe);
  return safe;
}

module.exports = { readCrmState, writeCrmState, defaultState };
