#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { permissionForTenantRequest } = require('../src/authorization');

const root = path.resolve(__dirname, '..');
const tenants = ['admin', 'panel', 'regina', 'portugal', 'felipe', 'ana'];
const sourceFiles = [
  path.join(root, 'server.js'),
  ...fs
    .readdirSync(path.join(root, 'src', 'routes', 'tenant'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(root, 'src', 'routes', 'tenant', name)),
];
const routes = [];

function samplePath(route) {
  return route.replace(/:[A-Za-z0-9_]+/g, 'sample');
}

function addForAllTenants(method, suffix, source) {
  for (const tenantId of tenants) {
    routes.push({ method, route: `/api/${tenantId}${suffix}`, tenantId, source });
  }
}

for (const file of sourceFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const sourceName = path.relative(root, file).replaceAll(path.sep, '/');
  let match;

  const staticPattern = /app\.(get|post|put|delete|patch)\(\s*["'](\/(?:api\/)?(?:admin|panel|regina|portugal|felipe|ana)(?:\/[^"']*)?)["']/g;
  while ((match = staticPattern.exec(source))) {
    const method = match[1].toUpperCase();
    const route = match[2];
    const tenantMatch = route.match(/^\/(?:api\/)?(admin|panel|regina|portugal|felipe|ana)(?:\/|$)/);
    if (tenantMatch) routes.push({ method, route, tenantId: tenantMatch[1], source: sourceName });
  }

  const apiPrefixPattern = /app\.(get|post|put|delete|patch)\(\s*`\$\{apiPrefix\}(\/[^`]*)`/g;
  while ((match = apiPrefixPattern.exec(source))) {
    addForAllTenants(match[1].toUpperCase(), match[2], sourceName);
  }

  const builderPattern = /app\.(get|post|put|delete|patch)\(\s*`\$\{prefix\}(\/[^`]*)`/g;
  while ((match = builderPattern.exec(source))) {
    addForAllTenants(match[1].toUpperCase(), match[2], sourceName);
  }

  const tenantUiPattern = /app\.(get|post|put|delete|patch)\(\s*`\/\$\{tenantId\}(\/[^`]*)?`/g;
  while ((match = tenantUiPattern.exec(source))) {
    for (const tenantId of tenants) {
      routes.push({
        method: match[1].toUpperCase(),
        route: `/${tenantId}${match[2] || ''}`,
        tenantId,
        source: sourceName,
      });
    }
  }
}

const failures = [];
for (const item of routes) {
  const permission = permissionForTenantRequest({ method: item.method, path: samplePath(item.route) }, item.tenantId);
  if (permission === undefined) failures.push(item);
}

const unique = new Map();
for (const item of routes) unique.set(`${item.method} ${item.route}`, item);
const report = {
  ok: failures.length === 0,
  checked: unique.size,
  sourceFiles: sourceFiles.map((file) => path.relative(root, file).replaceAll(path.sep, '/')),
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
