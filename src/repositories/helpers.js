'use strict';

function jsonParam(db, value) {
  return db.dialect === 'postgres' ? (value ?? {}) : JSON.stringify(value ?? {});
}
function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function boolParam(db, value) { return db.dialect === 'postgres' ? Boolean(value) : (value ? 1 : 0); }
function dbErrorCode(error) {
  return String(error?.code || error?.errno || '');
}
function isUniqueViolation(error) {
  const code = dbErrorCode(error);
  return code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(String(error?.message || ''));
}
module.exports = { jsonParam, parseJson, boolParam, isUniqueViolation };
