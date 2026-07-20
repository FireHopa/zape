#!/usr/bin/env node
'use strict';
const { StructuredLogger } = require('../src/structuredLogger');
const { AlertManager } = require('../src/alertManager');
const { collectSystemSnapshot, evaluateSystemAlerts } = require('../src/systemMonitor');
const databaseRuntime = require('../src/database/runtime');
(async()=>{const logger=new StructuredLogger();const alerts=new AlertManager({logger});let initialized=false;try{await databaseRuntime.initializeDatabaseRuntime();initialized=true;}catch{}const snapshot=await collectSystemSnapshot({databaseHealth:initialized?()=>databaseRuntime.health():null});const results=await evaluateSystemAlerts(snapshot,alerts);console.log(JSON.stringify({ok:true,snapshot,alerts:results.map((r)=>({emitted:r.emitted,resolved:r.resolved,code:r.record?.code}))},null,2));if(initialized)await databaseRuntime.close();})().catch((error)=>{console.error(JSON.stringify({ok:false,message:error.message},null,2));process.exit(1);});
