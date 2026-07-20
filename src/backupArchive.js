'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { requireKey } = require('./secretVault');

const MAGIC = Buffer.from('ZAPEBACKUP1');
function sha256File(file) { const h = crypto.createHash('sha256'); h.update(fs.readFileSync(file)); return h.digest('hex'); }
function run(command, args, options = {}) { return new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: ['ignore','pipe','pipe'], ...options }); let stderr=''; child.stderr.on('data',(d)=>{stderr+=d;}); child.on('error',reject); child.on('close',(code)=>code===0?resolve():reject(new Error(`${command} falhou (${code}): ${stderr.slice(-1000)}`))); }); }
async function encryptFile(input, output, rawKey) {
  const key = requireKey(rawKey); const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); const handle = fs.openSync(output, 'w', 0o600); fs.writeSync(handle, MAGIC); fs.writeSync(handle, iv); fs.closeSync(handle);
  await pipeline(fs.createReadStream(input), cipher, fs.createWriteStream(output, { flags: 'a', mode: 0o600 })); const tag = cipher.getAuthTag(); fs.appendFileSync(output, tag); return { iv: iv.toString('hex'), tag: tag.toString('hex'), sha256: sha256File(output) };
}
async function decryptFile(input, output, rawKey) {
  const key = requireKey(rawKey); const stat = fs.statSync(input); if (stat.size < MAGIC.length + 12 + 16) throw new Error('Backup criptografado inválido.'); const fd = fs.openSync(input, 'r'); const magic = Buffer.alloc(MAGIC.length); fs.readSync(fd, magic, 0, magic.length, 0); if (!magic.equals(MAGIC)) { fs.closeSync(fd); throw new Error('Assinatura do backup inválida.'); } const iv = Buffer.alloc(12); fs.readSync(fd, iv, 0, 12, MAGIC.length); const tag = Buffer.alloc(16); fs.readSync(fd, tag, 0, 16, stat.size - 16); fs.closeSync(fd); const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag); await pipeline(fs.createReadStream(input, { start: MAGIC.length + 12, end: stat.size - 17 }), decipher, fs.createWriteStream(output, { mode: 0o600 })); return { sha256: sha256File(output) };
}
function checksumTree(root) { const rows=[]; function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(entry.isFile())rows.push({path:path.relative(root,full).replace(/\\/g,'/'),bytes:fs.statSync(full).size,sha256:sha256File(full)});}} walk(root); return rows; }
async function createEncryptedArchive({ sourceDir, outputFile, key = process.env.BACKUP_ENCRYPTION_KEY || process.env.CONFIG_ENCRYPTION_KEY, metadata = {} }) {
  const source = path.resolve(sourceDir); if (!fs.existsSync(source)) throw new Error('Diretório de backup inexistente.'); const temp = fs.mkdtempSync(path.join(os.tmpdir(),'zape-backup-')); const stage = path.join(temp,'payload'); fs.cpSync(source,stage,{recursive:true}); const manifest={schemaVersion:1,createdAt:new Date().toISOString(),metadata,files:checksumTree(stage)}; fs.writeFileSync(path.join(stage,'backup-manifest.json'),`${JSON.stringify(manifest,null,2)}\n`,{mode:0o600}); const tarFile=path.join(temp,'payload.tar.gz'); await run('tar',['-czf',tarFile,'-C',temp,'payload']); const encrypted=await encryptFile(tarFile,path.resolve(outputFile),key); fs.rmSync(temp,{recursive:true,force:true}); return {output:path.resolve(outputFile),encrypted:true,archiveSha256:encrypted.sha256,files:manifest.files.length,manifest}; }
async function extractEncryptedArchive({ inputFile, outputDir, key = process.env.BACKUP_ENCRYPTION_KEY || process.env.CONFIG_ENCRYPTION_KEY }) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'zape-restore-')); const tarFile=path.join(temp,'payload.tar.gz'); await decryptFile(path.resolve(inputFile),tarFile,key); fs.mkdirSync(outputDir,{recursive:true,mode:0o700}); await run('tar',['-xzf',tarFile,'-C',path.resolve(outputDir)]); const payload=path.join(path.resolve(outputDir),'payload'); const manifest=JSON.parse(fs.readFileSync(path.join(payload,'backup-manifest.json'),'utf8')); const actual=checksumTree(payload).filter((row)=>row.path!=='backup-manifest.json'); const expected=manifest.files; const ok=expected.length===actual.length&&expected.every((row,index)=>row.path===actual[index].path&&row.sha256===actual[index].sha256&&row.bytes===actual[index].bytes); fs.rmSync(temp,{recursive:true,force:true}); if(!ok)throw new Error('Conteúdo restaurado não corresponde ao manifesto.'); return {ok:true,payload,manifest,files:actual.length}; }
module.exports={createEncryptedArchive,extractEncryptedArchive,encryptFile,decryptFile,checksumTree,sha256File};
