'use strict';

const crypto = require('node:crypto');
const { encryptSecret, decryptSecret } = require('../secretVault');

const TABLES = ['tenants','users','roles','permissions','user_roles','role_permissions','sessions','leads','lead_sources','lead_changes','tags','lead_tags','funnels','funnel_stages','funnel_leads','conversations','messages','message_status_history','media','webhook_integrations','webhook_events','cloud_connections','cloud_templates','cloud_campaigns','cloud_dispatches','jobs','audit_logs','import_batches','import_quarantine'];
function checksum(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
async function createLogicalBackup(db, { key = process.env.CONFIG_ENCRYPTION_KEY, plaintextForTests = false } = {}) {
  const data = {};
  for (const table of TABLES) {
    const result = await db.query(`SELECT * FROM ${table}`);
    data[table] = result.rows;
  }
  const payload = { schemaVersion: 1, createdAt: new Date().toISOString(), dialect: db.dialect, tables: data };
  const serialized = JSON.stringify(payload);
  const envelope = plaintextForTests ? { encrypted: false, payload } : { encrypted: true, payload: encryptSecret(serialized, key) };
  return { ...envelope, checksum: checksum(serialized) };
}
async function restoreLogicalBackup(db, envelope, { key = process.env.CONFIG_ENCRYPTION_KEY } = {}) {
  const payload = envelope.encrypted ? JSON.parse(decryptSecret(envelope.payload, key)) : envelope.payload;
  const serialized = JSON.stringify(payload);
  if (checksum(serialized) !== envelope.checksum) throw new Error('Checksum do backup inválido.');
  await db.transaction(async (tx) => {
    for (const table of [...TABLES].reverse()) await tx.query(`DELETE FROM ${table}`);
    for (const table of TABLES) {
      for (const row of payload.tables[table] || []) {
        const columns = Object.keys(row);
        if (!columns.length) continue;
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(',');
        await tx.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${placeholders})`, columns.map((column) => row[column]));
      }
    }
    if (tx.dialect === 'postgres') {
      for (const table of ['lead_sources','lead_changes','message_status_history','audit_logs','import_quarantine']) {
        await tx.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT COUNT(*) > 0 FROM ${table}))`);
      }
    }
  });
  return { ok: true, tables: Object.fromEntries(TABLES.map((table) => [table, (payload.tables[table] || []).length])) };
}
module.exports = { TABLES, createLogicalBackup, restoreLogicalBackup };
