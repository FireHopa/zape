'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-conversation-media-'));
process.env.ZAPE_DATA_DIR = tempRoot;

const {
  appendConversationMessage,
  saveConversationMedia,
  resolveConversationMedia,
  flushAllConversationStores,
} = require('../src/tenantConversationStore');

const PNG = Buffer.concat([
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
  Buffer.alloc(128, 0),
]);

test.after(() => {
  flushAllConversationStores();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('mídia nova usa ID opaco e não contém telefone, nome original ou messageId', () => {
  const tenant = `panel_${crypto.randomBytes(4).toString('hex')}`;
  const digits = '5513999991111';
  const saved = saveConversationMedia(tenant, {
    toDigits: digits,
    messageId: 'mensagem-secreta-123',
    mimetype: 'image/png',
    buffer: PNG,
    filename: 'documento-cliente.png',
  });
  assert.match(saved.mediaId, /^m_[a-f0-9]{48}$/);
  assert.equal(saved.fileName.startsWith(`${saved.mediaId}.`), true);
  assert.equal(saved.fileName.includes(digits), false);
  assert.equal(saved.fileName.includes('cliente'), false);
  assert.equal(saved.fileName.includes('mensagem'), false);
  assert.equal(fs.statSync(saved.filePath).mode & 0o777, 0o600);
});

test('acesso exige relação exata entre tenant, conversa, mensagem e arquivo', () => {
  const tenant = `panel_${crypto.randomBytes(4).toString('hex')}`;
  const otherTenant = `admin_${crypto.randomBytes(4).toString('hex')}`;
  const digits = '5513999992222';
  const otherDigits = '5513999993333';
  const saved = saveConversationMedia(tenant, {
    toDigits: digits,
    messageId: 'msg-1',
    mimetype: 'image/png',
    buffer: PNG,
    filename: 'foto.png',
  });
  appendConversationMessage(tenant, digits, {
    id: 'msg-1', fromMe: false, body: 'Foto', hasMedia: true, mediaKind: 'image', mediaMime: 'image/png',
    mediaId: saved.mediaId, mediaFile: saved.fileName, mediaSize: saved.size, filename: 'foto.png', originalName: 'foto.png',
  });

  const allowed = resolveConversationMedia(tenant, digits, saved.mediaId);
  assert.equal(allowed.exists, true);
  assert.equal(allowed.filePath, saved.filePath);

  assert.equal(resolveConversationMedia(tenant, otherDigits, saved.mediaId), null);
  assert.equal(resolveConversationMedia(otherTenant, digits, saved.mediaId), null);
  assert.equal(resolveConversationMedia(tenant, digits, path.basename(saved.filePath) + '-inventado'), null);
});

test('referência existente com arquivo ausente é marcada como indisponível', () => {
  const tenant = `ana_${crypto.randomBytes(4).toString('hex')}`;
  const digits = '5513999994444';
  appendConversationMessage(tenant, digits, {
    id: 'msg-missing', fromMe: false, body: 'PDF', hasMedia: true, mediaKind: 'pdf', mediaMime: 'application/pdf',
    mediaId: 'm_missing', mediaFile: 'm_missing.pdf', filename: 'arquivo.pdf', originalName: 'arquivo.pdf',
  });
  const resolved = resolveConversationMedia(tenant, digits, 'm_missing');
  assert.ok(resolved);
  assert.equal(resolved.exists, false);
  assert.equal(resolved.filePath, null);
});


test('mídia legada sem nome original preserva a extensão sem expor o nome físico', () => {
  const tenant = `panel_legacy_${crypto.randomBytes(4).toString('hex')}`;
  const digits = '5511999991111';
  const tenantDir = path.join(tempRoot, tenant);
  const mediaDir = path.join(tenantDir, 'conversation_media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const physical = '5511999991111_old-message.png';
  fs.writeFileSync(path.join(mediaDir, physical), PNG);
  fs.writeFileSync(path.join(tenantDir, 'conversations.json'), JSON.stringify({
    [digits]: [{
      id: 'old-message',
      fromMe: false,
      body: 'Imagem',
      hasMedia: true,
      mediaKind: 'image',
      mediaMime: 'image/png',
      mediaFile: physical,
      timestamp: 1,
    }],
  }));

  const resolved = resolveConversationMedia(tenant, digits, physical);
  assert.ok(resolved);
  assert.equal(resolved.filename, 'arquivo.png');
  assert.equal(resolved.filename.includes('5511999991111'), false);
  assert.equal(resolved.filename.includes('old-message'), false);
});
