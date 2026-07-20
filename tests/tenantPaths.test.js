'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { dataRoot, tenantDir } = require('../src/tenantPaths');

test('ZAPE_DATA_DIR isola todos os stores baseados em tenantPaths', () => {
  const previous = process.env.ZAPE_DATA_DIR;
  const isolated = path.join(os.tmpdir(), 'zape-tenant-path-test');
  process.env.ZAPE_DATA_DIR = isolated;
  try {
    assert.equal(dataRoot(), path.resolve(isolated));
    assert.equal(tenantDir('admin'), path.join(path.resolve(isolated), 'admin'));
    assert.throws(() => tenantDir('../escape'), /Tenant inválido/);
  } finally {
    if (previous === undefined) delete process.env.ZAPE_DATA_DIR;
    else process.env.ZAPE_DATA_DIR = previous;
  }
});
