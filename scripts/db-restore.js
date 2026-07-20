#!/usr/bin/env node
'use strict';
const fs = require('node:fs'); const path = require('node:path');
const { createDatabase } = require('../src/database/client'); const { loadDatabaseConfig } = require('../src/database/config'); const { restoreLogicalBackup } = require('../src/database/backup');
function arg(name,fallback=''){const p=`--${name}=`;const x=process.argv.find((v)=>v.startsWith(p));return x?x.slice(p.length):fallback;}
(async()=>{if(arg('confirm')!=='RESTORE_DATABASE_BACKUP')throw new Error('Restauração exige --confirm=RESTORE_DATABASE_BACKUP.');const input=path.resolve(arg('input'));if(!input||!fs.existsSync(input))throw new Error('Arquivo de backup inexistente.');const db=createDatabase(loadDatabaseConfig());try{const result=await restoreLogicalBackup(db,JSON.parse(fs.readFileSync(input,'utf8')));console.log(JSON.stringify({ok:true,input,result},null,2));}finally{await db.close();}})().catch((e)=>{console.error(JSON.stringify({ok:false,message:e.message},null,2));process.exit(1);});
