const fs = require("fs");
const path = require("path");
const { ensureTenantDir, tenantDir } = require("./tenantPaths");

function filePath(tenantId) {
  return path.join(tenantDir(tenantId), "businessOwner.json");
}

function readBusinessOwner(tenantId) {
  ensureTenantDir(tenantId);
  const fp = filePath(tenantId);
  if (!fs.existsSync(fp)) return { name: "", business: "", email: "", whatsapp: "" };
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); }
  catch { return { name: "", business: "", email: "", whatsapp: "" }; }
}

function writeBusinessOwner(tenantId, owner) {
  ensureTenantDir(tenantId);
  const clean = {
    name: String(owner && owner.name || "").trim(),
    business: String(owner && owner.business || "").trim(),
    email: String(owner && owner.email || "").trim(),
    whatsapp: String(owner && owner.whatsapp || "").trim(),
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(filePath(tenantId), JSON.stringify(clean, null, 2));
  return clean;
}

module.exports = { readBusinessOwner, writeBusinessOwner };
