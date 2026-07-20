#!/usr/bin/env node
'use strict';
const fs = require('node:fs'); const path = require('node:path');
const { createDatabase } = require('../src/database/client'); const { loadDatabaseConfig } = require('../src/database/config'); const { createLogicalBackup } = require('../src/database/backup');
function arg(name, fallback=''){const p=`--${name}=`;const x=process.argv.find((v)=>v.startsWith(p));return x?x.slice(p.length):fallback;}
(async()=>{const output=path.resolve(arg('output',`backups/database-${Date.now()}.json`));const plaintext=process.argv.includes('--allow-plaintext-test');if(plaintext&&process.env.NODE_ENV==='production')throw new Error('Backup sem criptografia é proibido em produção.');const db=createDatabase(loadDatabaseConfig());try{const backup=await createLogicalBackup(db,{plaintextForTests:plaintext});fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,`${JSON.stringify(backup)}\n`,{mode:0o600});console.log(JSON.stringify({ok:true,output,encrypted:backup.encrypted,checksum:backup.checksum},null,2));}finally{await db.close();}})().catch((e)=>{console.error(JSON.stringify({ok:false,message:e.message},null,2));process.exit(1);});
