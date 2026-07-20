#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFile = outputArg ? path.resolve(outputArg.slice('--output='.length)) : '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function port() { return new Promise((resolve, reject) => { const s=net.createServer(); s.once('error',reject); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));}); }); }
async function waitHealth(base, child, timeout=20000) { const end=Date.now()+timeout; while(Date.now()<end){ if(child.exitCode!==null)return false; try{if((await fetch(base+'/health')).status===200)return true;}catch{} await sleep(100);} return false; }
async function stop(child){ if(!child||child.exitCode!==null)return; child.kill('SIGTERM'); await Promise.race([new Promise(r=>child.once('exit',r)),sleep(5000)]); if(child.exitCode===null)child.kill('SIGKILL'); }
function cookies(res){return res.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');} function cookieValue(c,n){const p=c.split(/;\s*/).find(x=>x.startsWith(n+'='));return p?decodeURIComponent(p.slice(n.length+1)):'';}
function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}
async function body(req){const chunks=[];for await(const c of req)chunks.push(c);return Buffer.concat(chunks);}

async function fakeMeta(portNumber){
  const counts={}; let ids=0; const requests=[];
  const server=http.createServer(async(req,res)=>{
    const raw=await body(req); let parsed={}; try{parsed=JSON.parse(raw.toString('utf8')||'{}');}catch{}
    requests.push({method:req.method,path:req.url,to:parsed.to||''});
    const u=new URL(req.url,`http://127.0.0.1:${portNumber}`);
    if(req.method==='POST'&&u.pathname==='/v25.0/100/messages'){
      const to=String(parsed.to||''); counts[to]=(counts[to]||0)+1;
      if(to.endsWith('0002')&&counts[to]<3) return json(res,503,{error:{code:131016,message:'Service unavailable',is_transient:true}});
      if(to.endsWith('0003')) return json(res,400,{error:{code:133010,message:'Account not registered'}});
      ids+=1; return json(res,200,{messages:[{id:`wamid.phase10.${ids}`}],contacts:[{wa_id:to}]});
    }
    return json(res,404,{error:{code:100,message:'not found'}});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(portNumber,'127.0.0.1',resolve);});
  return {server,counts,requests};
}

async function login(base,tenant,user,password){
  const r=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({tenant,username:user,password})});
  assert.equal(r.status,200,await r.text()); const cookie=cookies(r); return {cookie,csrf:cookieValue(cookie,'zape_csrf')};
}
async function pollJob(base,auth,id,timeout=20000){
  const end=Date.now()+timeout; while(Date.now()<end){const r=await fetch(`${base}/api/wa-cloud/jobs/${id}`,{headers:{Cookie:auth.cookie}});const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));if(['completed','completed_with_errors','failed','canceled'].includes(j.job.state))return j.job;await sleep(100);}throw new Error('job timeout');
}

(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'zape-phase10-smoke-')); const dataDir=path.join(root,'data'); fs.mkdirSync(dataDir,{recursive:true});
  const appPort=await port(); const metaPort=await port(); const base=`http://127.0.0.1:${appPort}`; const meta=await fakeMeta(metaPort);
  const user=`panel_${crypto.randomBytes(4).toString('hex')}`; const pass=crypto.randomBytes(32).toString('base64url');
  const env={...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(appPort),PUBLIC_BASE_URL:base,ZAPE_DATA_DIR:dataDir,
    SESSION_SECRET:crypto.randomBytes(48).toString('base64url'),SESSION_STORE_FILE:path.join(root,'sessions.json'),SECURITY_AUDIT_FILE:path.join(root,'audit.jsonl'),CONFIG_ENCRYPTION_KEY:crypto.randomBytes(32).toString('base64'),
    ADMIN_ENABLED:'0',PANEL_ENABLED:'1',PANEL_USER:user,PANEL_PASS:pass,REGINA_ENABLED:'0',PORTUGAL_ENABLED:'0',FELIPE_ENABLED:'0',ANA_ENABLED:'0',
    WEBJS_ENABLED:'0',WEBJS_AUTO_START:'0',CRM_INTEGRATION_ENABLED:'0',PUBLIC_LEAD_FORM_ENABLED:'0',ACTIVECAMPAIGN_WEBHOOK_ENABLED:'0',DATA_INTEGRITY_VALIDATE_ON_BOOT:'0',
    WA_CLOUD_ENABLED:'1',WA_CLOUD_FORCE_ENV:'1',WA_CLOUD_TOKEN:'synthetic-token',WA_CLOUD_PHONE_NUMBER_ID:'100',WA_CLOUD_WABA_ID:'200',WA_CLOUD_GRAPH_VERSION:'v25.0',WA_CLOUD_GRAPH_BASE_URL:`http://127.0.0.1:${metaPort}`,WA_CLOUD_CONNECTION_OWNER_TENANT:'admin',
    WA_CLOUD_QUEUE_POLL_MS:'50',WA_CLOUD_QUEUE_MAX_ATTEMPTS:'4',WA_CLOUD_QUEUE_RETRY_BASE_MS:'50',WA_CLOUD_QUEUE_RETRY_MAX_MS:'100',
  };
  let child; let stdout=''; let stderr=''; const spawnApp=()=>{const c=spawn(process.execPath,['server.js'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});c.stdout.on('data',x=>stdout+=x);c.stderr.on('data',x=>stderr+=x);return c;};
  const evidence={phase:10,syntheticOnly:true,generatedAt:new Date().toISOString(),checks:{}};
  try{
    child=spawnApp(); assert.equal(await waitHealth(base,child),true,JSON.stringify({stdout,stderr})); const auth=await login(base,'panel',user,pass);
    const payload={templateName:'template_teste',languageCode:'pt_BR',campaignName:'Fila sintética',throttleMs:0,contacts:[{to:'551100000001',vars:['A']},{to:'551100000002',vars:['B']},{to:'551100000003',vars:['C']}]};
    const started=Date.now();
    const first=await fetch(base+'/api/wa-cloud/send-template-batch',{method:'POST',headers:{Cookie:auth.cookie,Origin:base,'Content-Type':'application/json','X-Zape-CSRF-Token':auth.csrf,'Idempotency-Key':'phase10-same'},body:JSON.stringify(payload)});
    const firstBody=await first.json(); assert.equal(first.status,202,JSON.stringify(firstBody)); assert.ok(firstBody.job.id); assert.ok(Date.now()-started<2000);
    const repeated=await fetch(base+'/api/wa-cloud/send-template-batch',{method:'POST',headers:{Cookie:auth.cookie,Origin:base,'Content-Type':'application/json','X-Zape-CSRF-Token':auth.csrf,'Idempotency-Key':'phase10-same'},body:JSON.stringify(payload)});
    const repeatedBody=await repeated.json(); assert.equal(repeated.status,202); assert.equal(repeatedBody.duplicate,true); assert.equal(repeatedBody.job.id,firstBody.job.id);
    const conflict=await fetch(base+'/api/wa-cloud/send-template-batch',{method:'POST',headers:{Cookie:auth.cookie,Origin:base,'Content-Type':'application/json','X-Zape-CSRF-Token':auth.csrf,'Idempotency-Key':'phase10-same'},body:JSON.stringify({...payload,campaignName:'Outro payload'})});
    assert.equal(conflict.status,409);
    const done=await pollJob(base,auth,firstBody.job.id); assert.equal(done.state,'completed_with_errors'); assert.deepEqual(done.progress,{total:3,processed:3,sent:2,delivered:0,read:0,responded:0,failed:1,pending:0});
    assert.equal(meta.counts['551100000001'],1); assert.equal(meta.counts['551100000002'],3); assert.equal(meta.counts['551100000003'],1);
    const health=await fetch(base+'/api/wa-cloud/jobs-health',{headers:{Cookie:auth.cookie}}).then(r=>r.json()); assert.equal(health.ok,true); assert.equal(health.queue.workerRunning,true);
    evidence.checks.async={status:202,jobIdPresent:true,fastResponse:true}; evidence.checks.idempotency={duplicateSameJob:true,conflict:409}; evidence.checks.retry={transientAttempts:3,permanentAttempts:1,sent:2,failed:1};

    const pausedResponse=await fetch(base+'/api/wa-cloud/send-template-batch',{method:'POST',headers:{Cookie:auth.cookie,Origin:base,'Content-Type':'application/json','X-Zape-CSRF-Token':auth.csrf,'Idempotency-Key':'phase10-restart'},body:JSON.stringify({templateName:'template_teste',contacts:[{to:'551100000011'},{to:'551100000012'}],throttleMs:500})});
    const pausedBody=await pausedResponse.json(); assert.equal(pausedResponse.status,202);
    const pause=await fetch(`${base}/api/wa-cloud/jobs/${pausedBody.job.id}/pause`,{method:'POST',headers:{Cookie:auth.cookie,Origin:base,'X-Zape-CSRF-Token':auth.csrf}}); assert.equal(pause.status,200);
    await stop(child); child=spawnApp(); assert.equal(await waitHealth(base,child),true); const auth2=await login(base,'panel',user,pass);
    const persisted=await fetch(`${base}/api/wa-cloud/jobs/${pausedBody.job.id}`,{headers:{Cookie:auth2.cookie}}).then(r=>r.json()); assert.equal(persisted.job.state,'paused');
    const resume=await fetch(`${base}/api/wa-cloud/jobs/${pausedBody.job.id}/resume`,{method:'POST',headers:{Cookie:auth2.cookie,Origin:base,'X-Zape-CSRF-Token':auth2.csrf}}); assert.equal(resume.status,200);
    const resumedDone=await pollJob(base,auth2,pausedBody.job.id); assert.equal(resumedDone.state,'completed'); assert.equal(resumedDone.progress.sent,2);
    evidence.checks.restart={persistedPaused:true,resumed:true,completed:true};
    if(outputFile){fs.mkdirSync(path.dirname(outputFile),{recursive:true});fs.writeFileSync(outputFile,JSON.stringify(evidence,null,2)+'\n');}
    console.log(JSON.stringify(evidence,null,2));
  }finally{await stop(child);await new Promise(r=>meta.server.close(r));fs.rmSync(root,{recursive:true,force:true});}
})().catch((error)=>{console.error(error.stack||error);process.exitCode=1;});
