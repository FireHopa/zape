#!/usr/bin/env node
'use strict';
const fs=require('node:fs');const path=require('node:path');
const file=path.join(__dirname,'..','db','migrations','postgres','001_initial_schema.sql');const sql=fs.readFileSync(file,'utf8');
const required=['tenants','users','roles','permissions','sessions','leads','lead_sources','lead_changes','tags','lead_tags','funnels','funnel_stages','funnel_leads','conversations','messages','message_status_history','media','webhook_integrations','webhook_events','cloud_connections','cloud_templates','cloud_campaigns','cloud_dispatches','jobs','audit_logs'];
const missing=required.filter((table)=>!new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`,'i').test(sql));
const checks={tenantForeignKeys:(sql.match(/tenant_id text NOT NULL REFERENCES tenants\(id\)/g)||[]).length,transactionsSupported:/FOREIGN KEY|REFERENCES/i.test(sql),leadPhoneUnique:/CREATE UNIQUE INDEX IF NOT EXISTS leads_phone_unique ON leads\(tenant_id, phone_normalized\) WHERE phone_normalized IS NOT NULL/i.test(sql),metaMessageUnique:/UNIQUE \(connection_id, external_message_id\)/i.test(sql),idempotencyUnique:/idempotency_key_hash[\s\S]+UNIQUE/i.test(sql),jsonb:/\bjsonb\b/i.test(sql),encryptedSecretColumns:/encrypted_access_token|encrypted_app_secret|encrypted_secret/i.test(sql)};
const errors=[];if(missing.length)errors.push(`Tabelas ausentes: ${missing.join(', ')}`);if(checks.tenantForeignKeys<15)errors.push('Cobertura tenant_id insuficiente.');for(const [name,value] of Object.entries(checks))if(name!=='tenantForeignKeys'&&!value)errors.push(`Check ausente: ${name}`);
const result={ok:errors.length===0,file,requiredTables:required.length,missing,checks,errors};console.log(JSON.stringify(result,null,2));process.exit(errors.length?1:0);
