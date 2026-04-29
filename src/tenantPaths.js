const fs = require("fs");
const path = require("path");

function tenantDir(tenantId) {
  const t = String(tenantId || "").trim() || "admin";
  return path.join(__dirname, "..", "data", t);
}

function ensureTenantDir(tenantId) {
  const dir = tenantDir(tenantId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { tenantDir, ensureTenantDir };
