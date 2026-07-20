'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqliteClient } = require('../src/database/client');
const { migrateDatabase } = require('../src/database/migrations');
const { LeadRepository, RepositoryConflictError } = require('../src/repositories/leadRepository');
const { createLogicalBackup, restoreLogicalBackup } = require('../src/database/backup');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-db-'));
  const db = new SqliteClient(`sqlite:${path.join(root, 'zape.sqlite')}`);
  return { root, db };
}
async function seedTenant(db, id = 'panel') {
  const at = new Date().toISOString();
  await db.query('INSERT INTO tenants(id,name,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5)', [id, id, 'active', at, at]);
}

function serial(name, fn) {
  test(name, { concurrency: false }, async () => {
    const { root, db } = fixture();
    try {
      await migrateDatabase(db, path.join(__dirname, '..', 'db', 'migrations', 'sqlite'));
      await fn(db, root);
    } finally { await db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}

serial('migrations criam todas as tabelas relacionais e preservam checksum', async (db) => {
  const required = ['tenants','users','sessions','leads','lead_sources','lead_changes','tags','lead_tags','funnels','funnel_stages','funnel_leads','conversations','messages','message_status_history','media','webhook_integrations','webhook_events','cloud_connections','cloud_templates','cloud_campaigns','cloud_dispatches','jobs','audit_logs'];
  const rows = await db.query("SELECT name FROM sqlite_master WHERE type='table'");
  const names = new Set(rows.rows.map((row) => row.name));
  for (const table of required) assert.equal(names.has(table), true, table);
  const second = await migrateDatabase(db, path.join(__dirname, '..', 'db', 'migrations', 'sqlite'));
  assert.equal(second.every((item) => item.action === 'already_applied'), true);
});

serial('constraint impede telefone duplicado por tenant e permite o mesmo telefone em outro tenant', async (db) => {
  await seedTenant(db, 'panel'); await seedTenant(db, 'admin');
  const repo = new LeadRepository(db);
  await repo.create({ id: 'a', tenantId: 'panel', whatsapp: '+55 11 99999-0001', nome: 'A' });
  await assert.rejects(repo.create({ id: 'b', tenantId: 'panel', whatsapp: '+55 11 99999-0001', nome: 'B' }), (error) => error instanceof RepositoryConflictError && error.code === 'LEAD_UNIQUE_CONFLICT');
  await repo.create({ id: 'c', tenantId: 'admin', whatsapp: '+55 11 99999-0001', nome: 'C' });
  assert.equal((await repo.list('panel')).total, 1);
  assert.equal((await repo.list('admin')).total, 1);
});

serial('transação evita estado parcial quando a criação do histórico falha', async (db) => {
  await seedTenant(db);
  const repo = new LeadRepository(db);
  const lead = await repo.create({ id: 'a', tenantId: 'panel', whatsapp: '+55 11 99999-0002', nome: 'Antes' });
  await db.exec("CREATE TRIGGER fail_lead_change BEFORE INSERT ON lead_changes BEGIN SELECT RAISE(ABORT, 'history failure'); END;");
  await assert.rejects(repo.update('panel', 'a', lead.version, { nome: 'Depois' }));
  const after = await repo.getById('panel', 'a');
  assert.equal(after.nome, 'Antes');
  assert.equal(after.version, 1);
});

serial('duas criações concorrentes não ultrapassam a constraint', async (db) => {
  await seedTenant(db);
  const repo = new LeadRepository(db);
  const results = await Promise.allSettled([
    repo.create({ id: 'a', tenantId: 'panel', whatsapp: '+55 11 99999-0003', nome: 'A' }),
    repo.create({ id: 'b', tenantId: 'panel', whatsapp: '+55 11 99999-0003', nome: 'B' }),
  ]);
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(results.filter((row) => row.status === 'rejected').length, 1);
  assert.equal((await repo.list('panel')).total, 1);
});

serial('backup lógico restaura o banco em ambiente separado', async (db, root) => {
  await seedTenant(db);
  const repo = new LeadRepository(db);
  await repo.create({ id: 'a', tenantId: 'panel', whatsapp: '+55 11 99999-0004', nome: 'Backup' });
  const backup = await createLogicalBackup(db, { plaintextForTests: true });
  const restored = new SqliteClient(`sqlite:${path.join(root, 'restored.sqlite')}`);
  try {
    await migrateDatabase(restored, path.join(__dirname, '..', 'db', 'migrations', 'sqlite'));
    await restoreLogicalBackup(restored, backup);
    const row = await restored.query('SELECT name,phone_normalized FROM leads WHERE id=$1', ['a']);
    assert.equal(row.rows[0].name, 'Backup');
    assert.equal(row.rows[0].phone_normalized, '5511999990004');
  } finally { await restored.close(); }
});
