'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const {
  sanitizeFilename,
  validateMediaBuffer,
  validateMediaFile,
  streamRequestToTempFile,
  shouldServeInline,
  safeContentDisposition,
} = require('../src/mediaSecurity');

const PNG = Buffer.concat([
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
  Buffer.alloc(128, 0),
]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const WEBM = Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]), Buffer.alloc(128, 1)]);

function fakeZipWithEntries(names) {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  const central = names.map((name) => {
    const filename = Buffer.from(name);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(filename.length, 28);
    return Buffer.concat([header, filename]);
  });
  return Buffer.concat([local, ...central]);
}

function withTempFile(buffer, name, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-media-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  try { return callback(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('valida magic bytes, MIME, extensão e categoria', () => {
  const png = validateMediaBuffer(PNG, { declaredMime: 'image/png', filename: 'foto.png' });
  assert.equal(png.kind, 'image');
  assert.equal(png.mimetype, 'image/png');

  const pdf = validateMediaBuffer(PDF, { declaredMime: 'application/pdf', filename: 'contrato.pdf' });
  assert.equal(pdf.kind, 'pdf');
  assert.equal(shouldServeInline(pdf.kind), true);

  const audio = validateMediaBuffer(WEBM, { declaredMime: 'audio/webm', filename: 'audio.webm' });
  assert.equal(audio.kind, 'audio');
  assert.equal(audio.mimetype, 'audio/webm');
});


test('confirma estrutura mínima de pacotes Office e bloqueia ZIP renomeado', () => {
  const docx = fakeZipWithEntries(['[Content_Types].xml', 'word/document.xml']);
  const result = validateMediaBuffer(docx, {
    declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filename: 'documento.docx',
  });
  assert.equal(result.kind, 'document');

  const fakeDocx = fakeZipWithEntries(['arquivo.txt']);
  assert.throws(
    () => validateMediaBuffer(fakeDocx, {
      declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: 'documento.docx',
    }),
    (error) => error.code === 'MEDIA_PACKAGE_MISMATCH'
  );
});

test('rejeita extensão ou MIME incompatível', () => {
  assert.throws(
    () => validateMediaBuffer(PNG, { declaredMime: 'image/jpeg', filename: 'foto.jpg' }),
    (error) => error.code === 'MEDIA_EXTENSION_MISMATCH' && error.statusCode === 415
  );
  assert.throws(
    () => validateMediaBuffer(PDF, { declaredMime: 'image/png', filename: 'foto.png' }),
    (error) => error.code === 'MEDIA_EXTENSION_MISMATCH' && error.statusCode === 415
  );
});

test('bloqueia SVG, HTML e conteúdo executável disfarçado', () => {
  assert.throws(
    () => validateMediaBuffer(Buffer.from('<svg onload="alert(1)"></svg>'), { declaredMime: 'image/svg+xml', filename: 'x.svg' }),
    (error) => ['MEDIA_ACTIVE_CONTENT_BLOCKED', 'MEDIA_TYPE_BLOCKED'].includes(error.code)
  );
  assert.throws(
    () => validateMediaBuffer(Buffer.from('<!doctype html><script>alert(1)</script>'), { declaredMime: 'image/jpeg', filename: 'foto.jpg' }),
    (error) => error.code === 'MEDIA_ACTIVE_CONTENT_BLOCKED'
  );
});

test('rejeita arquivo vazio, assinatura desconhecida e limite excedido', () => {
  assert.throws(() => validateMediaBuffer(Buffer.alloc(0), { declaredMime: 'image/png', filename: 'x.png' }), /Arquivo vazio/);
  assert.throws(
    () => validateMediaBuffer(Buffer.from([1,2,3,4,5,6,7,8]), { declaredMime: 'image/png', filename: 'x.png' }),
    (error) => error.code === 'MEDIA_SIGNATURE_UNKNOWN'
  );
  const oversizedText = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41);
  assert.throws(
    () => validateMediaBuffer(oversizedText, { declaredMime: 'text/plain', filename: 'x.txt' }),
    (error) => error.code === 'MEDIA_TOO_LARGE_FOR_TYPE' && error.statusCode === 413
  );
});

test('valida arquivo em disco sem carregar todo o conteúdo', () => {
  withTempFile(PNG, 'safe.png', (file) => {
    const result = validateMediaFile(file, { declaredMime: 'image/png', filename: 'safe.png' });
    assert.equal(result.size, PNG.length);
    assert.equal(result.kind, 'image');
  });
});

test('upload binário é transmitido para arquivo temporário com limite e hash', async () => {
  const request = Readable.from([PNG.slice(0, 16), PNG.slice(16)]);
  request.headers = { 'content-length': String(PNG.length) };
  const uploaded = await streamRequestToTempFile(request, { maxBytes: PNG.length + 10, prefix: 'zape-stream-test-' });
  try {
    assert.deepEqual(fs.readFileSync(uploaded.filePath), PNG);
    assert.equal(uploaded.size, PNG.length);
    assert.match(uploaded.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(uploaded.filePath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(uploaded.tempDir, { recursive: true, force: true });
  }

  const tooLarge = Readable.from([Buffer.alloc(32)]);
  tooLarge.headers = { 'content-length': '32' };
  await assert.rejects(
    () => streamRequestToTempFile(tooLarge, { maxBytes: 16, prefix: 'zape-stream-limit-' }),
    (error) => error.code === 'MEDIA_TOO_LARGE' && error.statusCode === 413
  );
});

test('sanitiza nome de download e gera Content-Disposition seguro', () => {
  assert.equal(sanitizeFilename('../../\r\nmalicioso.pdf'), 'malicioso.pdf');
  const disposition = safeContentDisposition('relatório "final".pdf', false);
  assert.match(disposition, /^attachment;/);
  assert.doesNotMatch(disposition, /\r|\n/);
  assert.match(disposition, /filename\*=UTF-8''/);
});
