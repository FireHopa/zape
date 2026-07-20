'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('frontend enfileira campanha e consulta progresso sem depender da requisição longa', () => {
  assert.match(appJs, /send-template-batch/);
  assert.match(appJs, /cloudPollCampaignJob/);
  assert.match(appJs, /\/api\/wa-cloud\/jobs\//);
  assert.match(appJs, /O processamento continua no servidor mesmo se esta tela for fechada/);
  assert.doesNotMatch(appJs, /Mantenha esta tela aberta até finalizar o retorno do servidor/);
});
