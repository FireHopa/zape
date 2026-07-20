#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { buildRetentionPlan, executeRetentionPlan } = require('../src/retentionPolicy');
function arg(name, fallback=''){const prefix=`--${name}=`;const item=process.argv.find((v)=>v.startsWith(prefix));return item?item.slice(prefix.length):fallback;}
const apply=process.argv.includes('--apply');
if(apply&&arg('confirm')!=='APPLY_RETENTION_POLICY')throw new Error('Aplicação exige --confirm=APPLY_RETENTION_POLICY.');
const plan=buildRetentionPlan();
const result=executeRetentionPlan(plan,{apply,quarantineDir:path.resolve(arg('quarantine-dir',path.join(plan.root,'quarantine',`retention-${Date.now()}`)))});
console.log(JSON.stringify({ok:true,mode:apply?'apply':'dry-run',plan,result},null,2));
