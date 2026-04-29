const fs = require("fs");
const path = require("path");
const { ensureTenantDir, tenantDir } = require("./tenantPaths");

function leadsFile(tenantId) {
  return path.join(tenantDir(tenantId), "leads.jsonl");
}

function readLeads(tenantId) {
  const filePath = leadsFile(tenantId);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  if (!content) return [];

  const lines = content.split("\n");
  const leads = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      leads.push(JSON.parse(s));
    } catch {
      // ignora linha zoada
    }
  }

  // mais recente primeiro
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

module.exports = { readLeads, appendLead, toCSV };
