'use strict';

function numberEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function config() {
  return {
    windowMs: numberEnv('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    blockMs: numberEnv('AUTH_RATE_LIMIT_BLOCK_MS', 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    ipMax: numberEnv('AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS', 12, 1, 10000),
    tenantIpMax: numberEnv('AUTH_RATE_LIMIT_TENANT_IP_MAX_ATTEMPTS', 6, 1, 10000),
    tenantMax: numberEnv('AUTH_RATE_LIMIT_TENANT_MAX_ATTEMPTS', 120, 1, 100000),
  };
}

function clientIp(req) {
  const trustForwarded = /^(1|true|yes|on)$/i.test(String(process.env.AUTH_TRUST_PROXY_HEADERS || '').trim());
  if (trustForwarded && req?.ip) return String(req.ip);
  return String(req.socket?.remoteAddress || req.connection?.remoteAddress || req.ip || 'unknown');
}

class LoginRateLimiter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.buckets = new Map();
  }

  _keys(req, tenantId) {
    const ip = clientIp(req);
    const tenant = String(tenantId || 'unknown').toLowerCase();
    return {
      ip: `ip:${ip}`,
      tenantIp: `tenant-ip:${tenant}:${ip}`,
      tenant: `tenant:${tenant}`,
    };
  }

  _get(key, now) {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    if (bucket.windowStartedAt + bucket.windowMs <= now && bucket.blockedUntil <= now) {
      this.buckets.delete(key);
      return null;
    }
    return bucket;
  }

  check(req, tenantId) {
    const now = this.now();
    const keys = this._keys(req, tenantId);
    let retryAfterMs = 0;
    for (const key of Object.values(keys)) {
      const bucket = this._get(key, now);
      if (bucket && bucket.blockedUntil > now) {
        retryAfterMs = Math.max(retryAfterMs, bucket.blockedUntil - now);
      }
    }
    return { blocked: retryAfterMs > 0, retryAfterMs, keys };
  }

  recordFailure(req, tenantId) {
    const now = this.now();
    const limits = config();
    const keys = this._keys(req, tenantId);
    const specs = [
      [keys.ip, limits.ipMax],
      [keys.tenantIp, limits.tenantIpMax],
      [keys.tenant, limits.tenantMax],
    ];

    let blockedUntil = 0;
    for (const [key, maxAttempts] of specs) {
      let bucket = this._get(key, now);
      if (!bucket) {
        bucket = { count: 0, windowStartedAt: now, windowMs: limits.windowMs, blockedUntil: 0 };
      }
      bucket.count += 1;
      if (bucket.count >= maxAttempts) bucket.blockedUntil = Math.max(bucket.blockedUntil, now + limits.blockMs);
      this.buckets.set(key, bucket);
      blockedUntil = Math.max(blockedUntil, bucket.blockedUntil);
    }
    return { blocked: blockedUntil > now, retryAfterMs: Math.max(0, blockedUntil - now) };
  }

  recordSuccess(req, tenantId) {
    const keys = this._keys(req, tenantId);
    this.buckets.delete(keys.tenantIp);
  }

  reset() {
    this.buckets.clear();
  }
}

module.exports = { LoginRateLimiter, clientIp, config };
