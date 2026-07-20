'use strict';

const cors = require('cors');
const helmet = require('helmet');
const { parseAllowedOrigins } = require('./csrfProtection');

function isProduction() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function buildHelmetMiddleware() {
  const directives = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
    scriptSrc: [
      "'self'",
      'https://connect.facebook.net',
      'https://cdn.jsdelivr.net',
    ],
    scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'", 'https://fonts.googleapis.com'],
    styleSrcElem: ["'self'", 'https://fonts.googleapis.com'],
    styleSrcAttr: ["'unsafe-inline'"],
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    mediaSrc: ["'self'", 'data:', 'blob:'],
    connectSrc: ["'self'", 'https://graph.facebook.com', 'https://www.facebook.com'],
    frameSrc: ["'self'", 'https://www.facebook.com'],
    workerSrc: ["'self'", 'blob:'],
    manifestSrc: ["'self'"],
    trustedTypes: ['default', 'dompurify'],
    requireTrustedTypesFor: ["'script'"],
  };
  if (isProduction()) directives.upgradeInsecureRequests = [];

  return helmet({
    contentSecurityPolicy: { useDefaults: false, directives },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    dnsPrefetchControl: { allow: false },
    frameguard: { action: 'deny' },
    hidePoweredBy: true,
    hsts: false,
    ieNoOpen: true,
    noSniff: true,
    originAgentCluster: true,
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xssFilter: false,
  });
}

function buildCorsMiddleware() {
  const allowed = parseAllowedOrigins();
  return cors({
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Zape-CSRF-Token', 'X-Zape-Timestamp', 'X-Zape-Event-Id', 'X-Zape-Signature', 'X-Hub-Signature-256'],
    maxAge: 600,
    origin(origin, callback) {
      if (!origin) return callback(null, false);
      let normalized = '';
      try { normalized = new URL(origin).origin; }
      catch { return callback(null, false); }
      return callback(null, allowed.has(normalized) ? normalized : false);
    },
  });
}

function securityResponseHeaders(req, res, next) {
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self), payment=(), usb=(), browsing-topics=()');
  const path = String(req.path || '');
  if (path === '/login' || path === '/admin' || path === '/panel' || path === '/regina' || path === '/portugal' || path === '/felipe' || path === '/ana' || path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
}

module.exports = {
  buildHelmetMiddleware,
  buildCorsMiddleware,
  securityResponseHeaders,
};
