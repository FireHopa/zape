#!/usr/bin/env node
'use strict';
const { verifySecurityAudit } = require('../src/securityAuditStore');
const result = verifySecurityAudit();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
