const fs = require("fs");
const path = require("path");
const { ensureTenantDir, tenantDir } = require("./tenantPaths");
const { readJsonlDetailed, atomicWriteFile } = require("./dataIntegrity");

function leadsFile(tenantId) {
  return path.join(tenantDir(tenantId), "leads.jsonl");
}

function quarantineInvalidLeadLines(tenantId, invalidLines) {
  const items = Array.isArray(invalidLines) ? invalidLines : [];
  if (!items.length) return;
  if (["0", "false", "no", "off"].includes(String(process.env.LEADS_INVALID_LINE_QUARANTINE || "1").trim().toLowerCase())) return;

  const dir = path.join(ensureTenantDir(tenantId), "quarantine");
  const filePath = path.join(dir, "invalid_leads_runtime.jsonl");
  const existingHashes = new Set();
  if (fs.existsSync(filePath)) {
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && row.rawHash) existingHashes.add(String(row.rawHash));
      } catch {}
    }
  }

  const additions = [];
  for (const invalid of items) {
    if (existingHashes.has(invalid.rawHash)) continue;
    existingHashes.add(invalid.rawHash);
    additions.push(JSON.stringify({
      schemaVersion: 1,
      detectedAt: new Date().toISOString(),
      source: "leads.jsonl",
      lineNumber: invalid.lineNumber,
      rawHash: invalid.rawHash,
      errorCode: invalid.errorCode,
      raw: invalid.raw,
    }));
  }
  if (!additions.length) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, additions.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function readLeads(tenantId) {
  const filePath = leadsFile(tenantId);
  const parsed = readJsonlDetailed(filePath);
  if (parsed.invalidLines.length) {
    quarantineInvalidLeadLines(tenantId, parsed.invalidLines);
    console.error(`[${tenantId}] leads.jsonl contém ${parsed.invalidLines.length} linha(s) inválida(s); hashes=${parsed.invalidLines.map((item) => item.rawHash.slice(0, 12)).join(",")}`);
  }
  const leads = parsed.records.map((record) => record.value);
  leads.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return leads;
}

async function appendLead(tenantId, lead) {
  const dir = ensureTenantDir(tenantId);
  const filePath = path.join(dir, "leads.jsonl");
  await fs.promises.appendFile(filePath, JSON.stringify(lead) + "\n");
}

function escapeCsvCell(v) {
  const s = v == null ? "" : String(v);
  if (/[\"\n\r;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function normalizeTags(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function normalizeWhatsApp(row) {
  return (
    row?.whatsapp ||
    row?.whatsapp_digits ||
    row?.whatsapp_raw ||
    row?.phone ||
    row?.telefone ||
    ""
  );
}

function formatDate(v) {
  if (!v) return "";
  return String(v);
}

function toCSV(rows) {
  const items = Array.isArray(rows) ? rows : [];
  const sep = ";";
  const bom = "\uFEFF";

  const header = [
    "Data",
    "Nome",
    "Empresa",
    "Já anuncia",
    "Website",
    "Email",
    "WhatsApp",
    "Tags",
    "Origem",
  ].join(sep);

  const lines = items.map((row) => {
    const values = [
      formatDate(row?.createdAt),
      row?.nome ?? "",
      row?.empresa ?? "",
      row?.jaAnuncia ?? "",
      row?.website ?? "",
      row?.email ?? "",
      normalizeWhatsApp(row),
      normalizeTags(row?.tags),
      row?.source ?? "",
    ];
    return values.map(escapeCsvCell).join(sep);
  });

  return bom + header + "\n" + lines.join("\n") + "\n";
}

function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, filePath);
}

function rewriteLeadsFile(tenantId, rows, { preservedRawLines = [] } = {}) {
  const dir = ensureTenantDir(tenantId);
  const filePath = path.join(dir, "leads.jsonl");
  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(filePath, backupPath);
    try { fs.chmodSync(backupPath, 0o600); } catch {}
  }
  const lines = (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .map((lead) => JSON.stringify(lead));
  for (const rawLine of Array.isArray(preservedRawLines) ? preservedRawLines : []) {
    if (String(rawLine || "").trim()) lines.push(String(rawLine));
  }
  atomicWriteFile(filePath, lines.length ? lines.join("\n") + "\n" : "", 0o600);
}


function leadVersion(lead) {
  const crypto = require("crypto");
  const stable = {
    id: String(lead?.id || ""),
    createdAt: String(lead?.createdAt || ""),
    updatedAt: String(lead?.updatedAt || ""),
    nome: String(lead?.nome || ""),
    empresa: String(lead?.empresa || ""),
    jaAnuncia: String(lead?.jaAnuncia || ""),
    website: String(lead?.website || ""),
    email: String(lead?.email || ""),
    whatsapp_raw: String(lead?.whatsapp_raw || ""),
    whatsapp_digits: String(lead?.whatsapp_digits || ""),
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function readRowsPreservingInvalid(tenantId) {
  const filePath = leadsFile(tenantId);
  const parsed = readJsonlDetailed(filePath);
  return {
    filePath,
    rows: parsed.records.map((record) => record.value),
    preservedRawLines: parsed.invalidLines.map((item) => item.raw),
  };
}

function findLeadById(tenantId, leadId) {
  const id = String(leadId || "").trim();
  if (!id) return null;
  return readLeads(tenantId).find((lead) => String(lead?.id || "") === id) || null;
}

function updateLeadById(tenantId, leadId, updater) {
  const id = String(leadId || "").trim();
  if (!id) throw new Error("leadId inválido.");
  const state = readRowsPreservingInvalid(tenantId);
  const index = state.rows.findIndex((lead) => String(lead?.id || "") === id);
  if (index < 0) return { ok: false, lead: null, previous: null };
  const previous = state.rows[index];
  const next = typeof updater === "function" ? updater({ ...previous }) : updater;
  if (!next || typeof next !== "object") throw new Error("Atualização de lead inválida.");
  state.rows[index] = next;
  rewriteLeadsFile(tenantId, state.rows, { preservedRawLines: state.preservedRawLines });
  return { ok: true, lead: next, previous };
}

function mergeLeadRecords(tenantId, targetId, sourceId, mergeFn) {
  const target = String(targetId || "").trim();
  const source = String(sourceId || "").trim();
  if (!target || !source || target === source) throw new Error("Leads de merge inválidos.");
  const state = readRowsPreservingInvalid(tenantId);
  const targetIndex = state.rows.findIndex((lead) => String(lead?.id || "") === target);
  const sourceIndex = state.rows.findIndex((lead) => String(lead?.id || "") === source);
  if (targetIndex < 0 || sourceIndex < 0) return { ok: false, target: null, source: null };
  const previousTarget = state.rows[targetIndex];
  const previousSource = state.rows[sourceIndex];
  const merged = mergeFn({ ...previousTarget }, { ...previousSource });
  if (!merged || typeof merged !== "object") throw new Error("Resultado de merge inválido.");
  const nextRows = state.rows.filter((_, index) => index !== sourceIndex);
  const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  nextRows[adjustedTargetIndex] = merged;
  rewriteLeadsFile(tenantId, nextRows, { preservedRawLines: state.preservedRawLines });
  return { ok: true, target: merged, previousTarget, source: previousSource };
}

function deleteLeadById(tenantId, leadId) {
  const id = String(leadId || "").trim();
  if (!id) throw new Error("leadId inválido.");

  const filePath = leadsFile(tenantId);
  if (!fs.existsSync(filePath)) {
    return { ok: false, deleted: null, removed: 0 };
  }

  const content = fs.readFileSync(filePath, "utf8");
  const rows = [];
  const preservedRawLines = [];
  let deleted = null;
  let removed = 0;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const row = JSON.parse(trimmed);
      if (String(row && row.id) === id) {
        deleted = deleted || row;
        removed += 1;
        continue;
      }
      rows.push(row);
    } catch {
      preservedRawLines.push(line);
    }
  }

  if (!removed) {
    return { ok: false, deleted: null, removed: 0 };
  }

  rewriteLeadsFile(tenantId, rows, { preservedRawLines });
  return { ok: true, deleted, removed };
}

module.exports = { readLeads, appendLead, deleteLeadById, toCSV, rewriteLeadsFile, quarantineInvalidLeadLines, leadVersion, findLeadById, updateLeadById, mergeLeadRecords };
