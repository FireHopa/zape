'use strict';

async function databaseHealth(db) {
  const started = Date.now();
  const result = await db.query('SELECT 1 AS ok');
  return { ok: Number(result.rows[0]?.ok) === 1, dialect: db.dialect, latencyMs: Date.now() - started };
}
module.exports = { databaseHealth };
