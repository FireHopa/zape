#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const htmlFile = path.join(ROOT, 'public', 'app.html');
const jsFile = path.join(ROOT, 'public', 'app.js');
const bootstrapFile = path.join(ROOT, 'public', 'security-bootstrap.js');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFile = outputArg ? path.resolve(outputArg.slice('--output='.length)) : '';

const html = fs.readFileSync(htmlFile, 'utf8');
const js = fs.readFileSync(jsFile, 'utf8');
const bootstrap = fs.readFileSync(bootstrapFile, 'utf8');

function count(re, text) {
  return [...text.matchAll(re)].length;
}

const prohibited = {
  documentWrite: count(/\bdocument\.write\s*\(/g, js),
  insertAdjacentHTML: count(/\binsertAdjacentHTML\s*\(/g, js),
  eval: count(/\beval\s*\(/g, js),
  newFunction: count(/\bnew\s+Function\s*\(/g, js),
};
const result = {
  ok: true,
  generatedAt: new Date().toISOString(),
  files: {
    html: path.relative(ROOT, htmlFile),
    javascript: path.relative(ROOT, jsFile),
    bootstrap: path.relative(ROOT, bootstrapFile),
  },
  sinks: {
    innerHTML: count(/\.innerHTML\b/g, js),
    textContent: count(/\.textContent\b/g, js),
    dynamicSrcAssignments: count(/\.src\s*=/g, js),
    dynamicHrefAssignments: count(/\.href\s*=/g, js),
    safeElementUrlCalls: count(/setSafeElementUrl\s*\(/g, js),
    safeMarkupUrlCalls: count(/safeUrlForMarkup\s*\(/g, js),
    safeCssColorCalls: count(/safeCssColor\s*\(/g, js),
    inlineStyleAttributesHtml: count(/\sstyle\s*=/gi, html),
    inlineStyleAttributesJs: count(/\sstyle\s*=/gi, js),
  },
  prohibited,
  controls: {
    noInlineStyleBlocks: !/<style(?:\s|>)/i.test(html),
    noInlineScripts: !/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(html),
    domPurifyLoaded: /\/vendor\/dompurify\.min\.js/.test(html),
    securityBootstrapLoadedBeforeApp: html.indexOf('/security-bootstrap.js') >= 0 && html.indexOf('/security-bootstrap.js') < html.indexOf('/app.js'),
    trustedTypesPolicy: /trustedTypes\.createPolicy\('default'/.test(bootstrap),
    domPurifySanitization: /purifier\.sanitize/.test(bootstrap),
    csrfFetchHeader: /X-Zape-CSRF-Token/.test(bootstrap),
    dangerousProtocolBlocked: /Protocolo de requisição bloqueado/.test(bootstrap),
  },
};

result.ok = Object.values(prohibited).every((value) => value === 0)
  && Object.values(result.controls).every(Boolean);

if (outputFile) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
