'use strict';
const { auditDataDirectory } = require('../src/dataIntegrity');
const { parseArgs, resolveDataDir, resolveOutputPath, writeReport } = require('./data-integrity-cli');
const args = parseArgs();
const dataDir = resolveDataDir(args);
const report = auditDataDirectory(dataDir);
writeReport(resolveOutputPath(args, 'data-integrity-audit.json'), report);
