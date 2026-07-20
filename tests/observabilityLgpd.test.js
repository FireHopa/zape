'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { StructuredLogger } = require('../src/structuredLogger');
const { MetricsRegistry } = require('../src/metricsRegistry');
const { AlertManager } = require('../src/alertManager');
const { recordSecurityAudit, verifySecurityAudit } = require('../src/securityAuditStore');
const { buildRetentionPlan, executeRetentionPlan } = require('../src/retentionPolicy');
const { exportJsonContact, deleteJsonContact } = require('../src/lgpdService');
const { createEncryptedArchive, extractEncryptedArchive } = require('../src/backupArchive');

function temporary(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function withEnv(values, fn) { const previous = {}; for (const [key,value] of Object.entries(values)) { previous[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = String(value); } return Promise.resolve().then(fn).finally(() => { for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }); }

test('logger estruturado mascara PII e segredos e mantém IDs de correlação', async () => {
  const stream = new PassThrough(); let output=''; stream.on('data',(chunk)=>{output+=chunk;});
  const logger = new StructuredLogger({ stream, env: { LOG_LEVEL: 'debug' } });
  logger.info('Lead processado token=segredo', { event:'lead.saved', correlationId:'req_12345678', operationId:'op_12345678', phone:'+5511999999999', email:'pessoa@example.com', authorization:'Bearer abc' });
  const row = JSON.parse(output.trim());
  assert.equal(row.event, 'lead.saved'); assert.equal(row.correlationId, 'req_12345678');
  assert.match(row.metadata.phone, /^\[masked:/); assert.match(row.metadata.email, /^\[masked:/); assert.equal(row.metadata.authorization, '[redacted]');
  assert.equal(output.includes('pessoa@example.com'), false); assert.equal(output.includes('5511999999999'), false);
});

test('auditoria possui encadeamento verificável e detecta adulteração', async () => {
  const root=temporary('zape-audit-'); const file=path.join(root,'audit.jsonl');
  await withEnv({ SECURITY_AUDIT_FILE:file }, async()=>{
    const req={method:'POST',path:'/api/panel/leads',correlationId:'req_12345678',operationId:'op_12345678',auth:{tenantId:'panel',role:'tenant_admin',userId:'panel:user'}};
    recordSecurityAudit({req,action:'lead.create',resource:'lead',details:{phone:'+5511999999999'}});
    recordSecurityAudit({req,action:'lead.export',resource:'leads.csv'});
    assert.deepEqual(verifySecurityAudit(file).ok,true);
    const lines=fs.readFileSync(file,'utf8').trim().split('\n'); const first=JSON.parse(lines[0]); first.action='tampered'; lines[0]=JSON.stringify(first); fs.writeFileSync(file,lines.join('\n')+'\n');
    assert.equal(verifySecurityAudit(file).ok,false);
  }); fs.rmSync(root,{recursive:true,force:true});
});

test('métricas registram HTTP, erros, gauges e formato Prometheus', () => {
  const registry=new MetricsRegistry(); registry.observeHttp({method:'GET',route:'/health',statusCode:200,durationMs:12}); registry.observeHttp({method:'POST',route:'/api',statusCode:500,durationMs:30}); registry.set('zape_queue_pending',{},4);
  const snapshot=registry.snapshot(); assert.equal(snapshot.counters.find((row)=>row.name==='zape_http_errors_total').value,1); assert.match(registry.prometheus(),/zape_queue_pending 4/);
});

test('alertas deduplicam por cooldown e registram resolução', async () => {
  const root=temporary('zape-alert-'); let now=100000; const logger={security(){},info(){},error(){}}; const manager=new AlertManager({env:{ALERT_STATE_FILE:path.join(root,'state.json'),ALERT_COOLDOWN_MS:'60000'},logger,now:()=>now,fetchImpl:null});
  assert.equal((await manager.notify({code:'QUEUE_STALLED',message:'Fila parada'})).emitted,true);
  now+=1000; assert.equal((await manager.notify({code:'QUEUE_STALLED',message:'Fila parada'})).emitted,false);
  assert.equal((await manager.notify({code:'QUEUE_STALLED',message:'Fila parada',active:false})).resolved,true);
  assert.equal(manager.list()[0].active,false); fs.rmSync(root,{recursive:true,force:true});
});

test('retenção opera em dry-run e move arquivos somente com apply', async () => {
  const root=temporary('zape-retention-'); const logs=path.join(root,'logs'); const data=path.join(root,'data'); fs.mkdirSync(logs,{recursive:true});fs.mkdirSync(data,{recursive:true}); const old=path.join(logs,'old.log');fs.writeFileSync(old,'x');const oldTime=new Date(Date.now()-40*86400000);fs.utimesSync(old,oldTime,oldTime);
  const env={ZAPE_DATA_DIR:data,ZAPE_LOG_DIR:logs,EXPORT_DIRECTORY:path.join(root,'exports'),BACKUP_DIRECTORY:path.join(root,'backups'),RETENTION_LOGS_DAYS:'30'}; const plan=buildRetentionPlan({env}); const dry=executeRetentionPlan(plan,{apply:false}); assert.equal(dry.files.candidates.length,1);assert.equal(fs.existsSync(old),true);
  const applied=executeRetentionPlan(plan,{apply:true,quarantineDir:path.join(root,'quarantine')});assert.equal(applied.files.moved.length,1);assert.equal(fs.existsSync(old),false);fs.rmSync(root,{recursive:true,force:true});
});

test('LGPD exporta e exclui contato em JSON com backup e sem afetar outro contato', async () => {
  const root=temporary('zape-lgpd-'); const tenant=path.join(root,'panel');fs.mkdirSync(path.join(tenant,'conversation_media'),{recursive:true});
  const leads=[{id:'a',nome:'Pessoa A',whatsapp_digits:'5511999990001'},{id:'b',nome:'Pessoa B',whatsapp_digits:'5511999990002'}];fs.writeFileSync(path.join(tenant,'leads.jsonl'),leads.map(JSON.stringify).join('\n')+'\n');
  fs.writeFileSync(path.join(tenant,'conversations.json'),JSON.stringify({'5511999990001':[{id:'m1',body:'segredo',mediaFile:'file.pdf'}],'5511999990002':[{id:'m2',body:'outro'}]}));fs.writeFileSync(path.join(tenant,'message_status.json'),JSON.stringify({m1:{phone:'5511999990001'},m2:{phone:'5511999990002'}}));fs.writeFileSync(path.join(tenant,'lead_tags.json'),JSON.stringify({a:['x'],b:['y']}));fs.writeFileSync(path.join(tenant,'crm.json'),JSON.stringify({pipelines:[{stages:[{leadIds:['a','b']}]}]}));fs.writeFileSync(path.join(tenant,'conversation_media','file.pdf'),'%PDF-1.4');
  await withEnv({ZAPE_DATA_DIR:root},async()=>{const exported=exportJsonContact({tenantId:'panel',phone:'+55 11 99999-0001'});assert.equal(exported.leads.length,1);assert.equal(exported.conversations[0].messages.length,1);const backup=path.join(root,'backup');const result=deleteJsonContact({tenantId:'panel',phone:'5511999990001',apply:true,backupDir:backup});assert.equal(result.counts.leads,1);assert.equal(exportJsonContact({tenantId:'panel',phone:'5511999990001'}).leads.length,0);assert.equal(exportJsonContact({tenantId:'panel',phone:'5511999990002'}).leads.length,1);assert.equal(fs.existsSync(path.join(backup,'lgpd-delete-manifest.json')),true);});fs.rmSync(root,{recursive:true,force:true});
});


test('LGPD no banco remove somente o contato e dados relacionais em transação', async () => {
  const { SqliteClient } = require('../src/database/client');
  const { migrateDatabase } = require('../src/database/migrations');
  const { exportDatabaseContact, deleteDatabaseContact } = require('../src/lgpdService');
  const root=temporary('zape-lgpd-db-'); const db=new SqliteClient(`sqlite:${path.join(root,'zape.sqlite')}`);
  try {
    await migrateDatabase(db,path.join(__dirname,'..','db','migrations','sqlite'));
    const now=new Date().toISOString();
    await db.query('INSERT INTO tenants(id,name,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5)',['panel','panel','active',now,now]);
    for (const [id,phone] of [['a','5511999990001'],['b','5511999990002']]) await db.query('INSERT INTO leads(id,tenant_id,phone_normalized,name,payload,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[id,'panel',phone,id,'{}',1,now,now]);
    await db.query('INSERT INTO conversations(id,tenant_id,phone_normalized,metadata,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)',['c1','panel','5511999990001','{}',now,now]);
    await db.query('INSERT INTO messages(id,tenant_id,conversation_id,direction,message_type,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',['m1','panel','c1','inbound','text','{}',now]);
    await db.query('INSERT INTO media(id,tenant_id,message_id,storage_key,mime_type,size_bytes,sha256,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',['media1','panel','m1','opaque','application/pdf',10,'hash1','{}',now]);
    assert.equal((await exportDatabaseContact({db,tenantId:'panel',phone:'5511999990001'})).messages.length,1);
    const dry=await deleteDatabaseContact({db,tenantId:'panel',phone:'5511999990001',apply:false}); assert.equal(dry.counts.media,1);
    await deleteDatabaseContact({db,tenantId:'panel',phone:'5511999990001',apply:true});
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM leads WHERE tenant_id=$1',['panel'])).rows[0].total),1);
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM conversations')).rows[0].total),0);
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM media')).rows[0].total),0);
  } finally { await db.close(); fs.rmSync(root,{recursive:true,force:true}); }
});

test('backup criptografado restaura conteúdo e rejeita chave incorreta', async () => {
  const root=temporary('zape-archive-'); const source=path.join(root,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'a.txt'),'conteudo');const output=path.join(root,'backup.enc');const key=Buffer.alloc(32,7).toString('hex');await createEncryptedArchive({sourceDir:source,outputFile:output,key});assert.equal(fs.readFileSync(output).includes(Buffer.from('conteudo')),false);const restore=path.join(root,'restore');const result=await extractEncryptedArchive({inputFile:output,outputDir:restore,key});assert.equal(result.ok,true);assert.equal(fs.readFileSync(path.join(result.payload,'a.txt'),'utf8'),'conteudo');await assert.rejects(extractEncryptedArchive({inputFile:output,outputDir:path.join(root,'bad'),key:Buffer.alloc(32,8).toString('hex')}));fs.rmSync(root,{recursive:true,force:true});
});
