'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataRoot, ensureTenantDir, tenantDir } = require('./tenantPaths');

const GUARD_VERSION = 1;
const REGISTRY_VERSION = 1;
const REGISTRY_FILE_NAME = 'wwebjs_account_registry.json';

function cleanTenant(value) {
  const tenantId = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(tenantId)) throw new Error('Tenant inválido.');
  return tenantId;
}

function dirHasAnyFile(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isFile() || (entry.isDirectory() && dirHasAnyFile(full));
    });
  } catch {
    return false;
  }
}

function authBaseDir(tenantId) {
  return path.join(tenantDir(cleanTenant(tenantId)), 'wwebjs_auth');
}

function cacheDir(tenantId) {
  return path.join(tenantDir(cleanTenant(tenantId)), 'wwebjs_cache');
}

function guardFile(tenantId) {
  return path.join(tenantDir(cleanTenant(tenantId)), 'wwebjs_session_guard.json');
}

function registryFile() {
  return path.join(dataRoot(), REGISTRY_FILE_NAME);
}

function emptyGuard(tenantId) {
  return {
    version: GUARD_VERSION,
    tenantId: cleanTenant(tenantId),
    requiresCleanup: false,
    accountHash: null,
    accountMasked: null,
    lastAuthenticatedAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastCleanupAt: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function readGuard(tenantId) {
  const tid = cleanTenant(tenantId);
  const parsed = readJson(guardFile(tid), emptyGuard(tid));
  return { ...emptyGuard(tid), ...(parsed && typeof parsed === 'object' ? parsed : {}), tenantId: tid };
}

function updateGuard(tenantId, patch = {}) {
  const tid = cleanTenant(tenantId);
  ensureTenantDir(tid);
  const next = {
    ...readGuard(tid),
    ...patch,
    version: GUARD_VERSION,
    tenantId: tid,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(guardFile(tid), next);
  return next;
}

function readRegistry() {
  const parsed = readJson(registryFile(), { version: REGISTRY_VERSION, accounts: [] });
  if (!parsed || !Array.isArray(parsed.accounts)) return { version: REGISTRY_VERSION, accounts: [] };
  return { version: REGISTRY_VERSION, accounts: parsed.accounts.filter((item) => item && item.accountHash && item.tenantId) };
}

function writeRegistry(registry) {
  atomicWriteJson(registryFile(), {
    version: REGISTRY_VERSION,
    accounts: Array.isArray(registry.accounts) ? registry.accounts : [],
    updatedAt: new Date().toISOString(),
  });
}

function accountFingerprint(accountId) {
  const raw = String(accountId || '').trim();
  if (!raw) return { accountHash: null, accountMasked: null };
  const accountHash = crypto.createHash('sha256').update(raw).digest('hex');
  const digits = raw.replace(/\D+/g, '');
  const accountMasked = digits.length >= 4 ? `••••${digits.slice(-4)}` : 'identidade protegida';
  return { accountHash, accountMasked };
}

function inspectTenantSession(tenantId) {
  const tid = cleanTenant(tenantId);
  const authDir = authBaseDir(tid);
  const authenticationExists = dirHasAnyFile(authDir);
  const guard = readGuard(tid);
  return {
    tenantId: tid,
    authenticationExists,
    requiresCleanup: Boolean(authenticationExists && guard.requiresCleanup),
    accountMasked: guard.accountMasked || null,
    lastConnectedAt: guard.lastConnectedAt || null,
    lastDisconnectedAt: guard.lastDisconnectedAt || null,
    lastCleanupAt: guard.lastCleanupAt || null,
    lastError: guard.lastError || null,
    canStartNewConnection: !authenticationExists,
    authDirectory: authDir,
  };
}

function registerConnectedAccount(tenantId, accountId) {
  const tid = cleanTenant(tenantId);
  const fingerprint = accountFingerprint(accountId);
  if (!fingerprint.accountHash) {
    const guard = updateGuard(tid, {
      requiresCleanup: false,
      lastConnectedAt: new Date().toISOString(),
      lastError: null,
    });
    return { ok: true, duplicate: false, guard };
  }

  const registry = readRegistry();
  const conflict = registry.accounts.find((entry) => {
    if (entry.accountHash !== fingerprint.accountHash || entry.tenantId === tid) return false;
    return inspectTenantSession(entry.tenantId).authenticationExists;
  });

  if (conflict) {
    const guard = updateGuard(tid, {
      requiresCleanup: true,
      accountHash: fingerprint.accountHash,
      accountMasked: fingerprint.accountMasked,
      lastError: `Esta conta já possui autenticação salva no painel ${conflict.tenantId}. Remova a autenticação antiga antes de conectar novamente.`,
    });
    return {
      ok: false,
      duplicate: true,
      conflictTenantId: conflict.tenantId,
      accountMasked: fingerprint.accountMasked,
      guard,
    };
  }

  const now = new Date().toISOString();
  registry.accounts = registry.accounts.filter((entry) => entry.tenantId !== tid && entry.accountHash !== fingerprint.accountHash);
  registry.accounts.push({
    tenantId: tid,
    accountHash: fingerprint.accountHash,
    accountMasked: fingerprint.accountMasked,
    connectedAt: now,
    updatedAt: now,
  });
  writeRegistry(registry);
  const guard = updateGuard(tid, {
    requiresCleanup: false,
    accountHash: fingerprint.accountHash,
    accountMasked: fingerprint.accountMasked,
    lastAuthenticatedAt: now,
    lastConnectedAt: now,
    lastError: null,
  });
  return { ok: true, duplicate: false, guard };
}

function markSessionError(tenantId, message, { requiresCleanup = true } = {}) {
  return updateGuard(tenantId, {
    requiresCleanup: Boolean(requiresCleanup && inspectTenantSession(tenantId).authenticationExists),
    lastError: String(message || 'Falha na sessão do WhatsApp.'),
    lastDisconnectedAt: new Date().toISOString(),
  });
}

function markSessionDisconnected(tenantId, reason) {
  return updateGuard(tenantId, {
    requiresCleanup: inspectTenantSession(tenantId).authenticationExists,
    lastDisconnectedAt: new Date().toISOString(),
    lastError: reason ? String(reason) : null,
  });
}

function unregisterTenantAccount(tenantId) {
  const tid = cleanTenant(tenantId);
  const registry = readRegistry();
  const before = registry.accounts.length;
  registry.accounts = registry.accounts.filter((entry) => entry.tenantId !== tid);
  if (registry.accounts.length !== before) writeRegistry(registry);
}

function removeTenantAuthenticationFiles(tenantId) {
  const tid = cleanTenant(tenantId);
  const authDir = authBaseDir(tid);
  const webCacheDir = cacheDir(tid);
  fs.rmSync(authDir, { recursive: true, force: true });
  fs.rmSync(webCacheDir, { recursive: true, force: true });
  unregisterTenantAccount(tid);
  const guard = updateGuard(tid, {
    requiresCleanup: false,
    accountHash: null,
    accountMasked: null,
    lastCleanupAt: new Date().toISOString(),
    lastError: null,
  });
  return { ok: true, tenantId: tid, guard };
}

module.exports = {
  GUARD_VERSION,
  REGISTRY_VERSION,
  dirHasAnyFile,
  authBaseDir,
  cacheDir,
  guardFile,
  registryFile,
  readGuard,
  updateGuard,
  inspectTenantSession,
  registerConnectedAccount,
  markSessionError,
  markSessionDisconnected,
  unregisterTenantAccount,
  removeTenantAuthenticationFiles,
  accountFingerprint,
};
