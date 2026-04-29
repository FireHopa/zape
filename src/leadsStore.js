const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "..", "data", "leads.jsonl");

function readLeads() {
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

function escapeCsvCell(v) {
  const s = v == null ? "" : String(v);
  // Se tem aspas, separador, quebra de linha -> precisa escapar
  if (/[\"\n\r;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function normalizeTags(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function normalizeWhatsApp(row) {
  // tenta achar o melhor campo disponível
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
  // Se vier ISO, já é ok. Se vier qualquer coisa, devolve string.
  return String(v);
}

function toCSV(rows) {
  const items = Array.isArray(rows) ? rows : [];
  const sep = ";";

  // BOM ajuda Excel a abrir UTF-8 certo
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

module.exports = { readLeads, toCSV };
