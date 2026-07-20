#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : fallback;
}

function validateDomain(value, name) {
  const domain = String(value || '').trim().toLowerCase();
  if (!domain || domain.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error(`${name} inválido.`);
  }
  return domain;
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function render({ domain, wwwDomain, templatePath, outputPath }) {
  const primary = validateDomain(domain, 'domain');
  const www = validateDomain(wwwDomain || `www.${primary}`, 'www-domain');
  const template = fs.readFileSync(templatePath, 'utf8');
  const rendered = template
    .replaceAll('__DOMAIN__', primary)
    .replaceAll('__WWW_DOMAIN__', www)
    .replaceAll('__DOMAIN_REGEX__', regexEscape(primary))
    .replaceAll('__WWW_DOMAIN_REGEX__', regexEscape(www));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, rendered, { mode: 0o640 });
  return { domain: primary, wwwDomain: www, outputPath, bytes: Buffer.byteLength(rendered) };
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const domain = arg('domain', process.env.ZAPE_DOMAIN);
    const wwwDomain = arg('www-domain', process.env.ZAPE_WWW_DOMAIN || (domain ? `www.${domain}` : ''));
    const templatePath = path.resolve(arg('template', path.join(root, 'nginx', 'templates', 'casa-do-ads.conf.template')));
    const outputPath = path.resolve(arg('output', path.join(root, 'nginx', 'rendered', 'casa-do-ads.conf')));
    console.log(JSON.stringify({ ok: true, ...render({ domain, wwwDomain, templatePath, outputPath }) }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  }
}

module.exports = { validateDomain, regexEscape, render };
