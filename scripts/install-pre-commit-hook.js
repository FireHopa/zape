#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const hook = path.join(root, '.git', 'hooks', 'pre-commit');
if (!fs.existsSync(path.dirname(hook))) throw new Error('Repositório Git não encontrado.');
fs.writeFileSync(hook, '#!/bin/sh\nnode scripts/check-secrets.js --staged\n', { mode: 0o755 });
console.log('Hook pre-commit instalado: verificação de segredos em arquivos staged.');
