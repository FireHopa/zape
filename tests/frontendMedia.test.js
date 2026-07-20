'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('frontend oferece upload binário autenticado sem Base64', () => {
  assert.match(html, /id="chatAttachmentInput"/);
  assert.match(html, /id="chatAttach"/);
  assert.match(js, /body:chatAudioBlob/);
  assert.match(js, /body:file/);
  assert.match(js, /X-Zape-Filename/);
  assert.doesNotMatch(js, /readAsDataURL/);
  assert.doesNotMatch(js, /audioDataUrl/);
});

test('frontend trata imagem, áudio, vídeo, PDF, documento e mídia indisponível', () => {
  assert.match(js, /msgMediaImage/);
  assert.match(js, /msgMediaVideo/);
  assert.match(js, /msgAudioPlayer/);
  assert.match(js, /Abrir PDF/);
  assert.match(js, /msgMediaCard/);
  assert.match(js, /mediaUnavailable/);
  assert.match(js, /mediaDownloadUrl/);
});
