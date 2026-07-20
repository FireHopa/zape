'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {loadDatabaseConfig}=require('../src/database/config');
test('modo database exige URL',()=>assert.throws(()=>loadDatabaseConfig({PERSISTENCE_MODE:'database'}),/DATABASE_URL/));
test('shadow exige prazo e responsável',()=>assert.throws(()=>loadDatabaseConfig({PERSISTENCE_MODE:'shadow',DATABASE_URL:'sqlite::memory:'}),/PERSISTENCE_SHADOW_UNTIL/));
test('produção rejeita SQLite',()=>assert.throws(()=>loadDatabaseConfig({PERSISTENCE_MODE:'database',DATABASE_URL:'sqlite::memory:',NODE_ENV:'production'}),/PostgreSQL/));
test('shadow válido é temporário',()=>{const out=loadDatabaseConfig({PERSISTENCE_MODE:'shadow',DATABASE_URL:'sqlite::memory:',PERSISTENCE_SHADOW_UNTIL:'2099-01-01T00:00:00Z',PERSISTENCE_SHADOW_OWNER:'owner'});assert.equal(out.mode,'shadow');});
