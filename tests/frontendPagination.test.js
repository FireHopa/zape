'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

test('frontend envia page e pageSize e navega consultando o backend', () => {
  assert.match(appJs, /p\.set\("page", String\(pageIndex \+ 1\)\)/);
  assert.match(appJs, /p\.set\("pageSize", String\(pageSize\)\)/);
  assert.match(appJs, /btnNext[\s\S]*loadLeads\(false\)/);
  assert.doesNotMatch(appJs, /var pageItems = list\.slice\(start, end\)/);
});

test('CRM e campanhas percorrem todas as páginas da mesma API de leads', () => {
  assert.match(appJs, /async function fetchAllLeadPages/);
  assert.match(appJs, /crmFetchJson\(CRM_API_PREFIX \+ "\/crm"\),\s*fetchAllLeadPages/);
  assert.match(appJs, /async function cloudGetLeadPickerItems\(\)[\s\S]*fetchAllLeadPages\(cloudLeadPickerQueryParams\(\)\)/);
  assert.match(appJs, /async function cloudUseCurrentLeads\(\)[\s\S]*fetchAllLeadPages\(buildLeadQueryParams\(\)\)/);
});

test('modal de lead oferece edição e merge somente após conflito explícito', () => {
  assert.match(appHtml, /id="btnSaveLead"/);
  assert.match(appHtml, /id="leadEditWhatsapp"/);
  assert.match(appJs, /LEAD_PHONE_CONFLICT/);
  assert.match(appJs, /confirm: 'MERGE_LEADS'/);
  assert.match(appJs, /sourceVersion: currentLeadForEdit\._version/);
});
