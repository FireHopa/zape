const fs = require("fs");
const path = require("path");
const { ensureTenantDir, tenantDir } = require("./tenantPaths");

// Armazena template padrão por tenant (whatsapp-web.js / WEBJS)
// Arquivo: data/<tenantId>/messageTemplate.json
//
// Formato:
// { "text": "Olá {{nome}}, ..."}
//
// Fallback (opcional): WEBJS_DEFAULT_TEMPLATE_TEXT
// Observação: para webhook custom message, isso NÃO é usado.

function filePath(tenantId) {
  return path.join(tenantDir(tenantId), "messageTemplate.json");
}

function getTemplate(tenantId) {
  const fp = filePath(tenantId);
  if (fs.existsSync(fp)) {
    try {
      const raw = fs.readFileSync(fp, "utf-8");
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") return obj;
    } catch {
      // cai no fallback
    }
  }

  const fallback = String(process.env.WEBJS_DEFAULT_TEMPLATE_TEXT || "").trim();
  return { text: fallback };
}

function setTemplate(tenantId, { text } = {}) {
  ensureTenantDir(tenantId);
  const t = String(text || "").trim();
  const obj = { text: t, updatedAt: new Date().toISOString() };
  fs.writeFileSync(filePath(tenantId), JSON.stringify(obj, null, 2), "utf-8");
  return obj;
}

module.exports = { getTemplate, setTemplate };
