'use strict';
const { validateDataIntegrityOnBoot } = require('../src/dataIntegrity');
const { parseArgs, resolveDataDir } = require('./data-integrity-cli');
const args = parseArgs(); const dataDir = resolveDataDir(args);
const result = validateDataIntegrityOnBoot(dataDir, { strict: Boolean(args.strict) });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.valid && args.strict) process.exitCode = 1;
