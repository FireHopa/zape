# Relatório da Fase 0

## FASE EXECUTADA

Fase 0. Preparação, inventário e linha de base.

## OBJETIVO

Criar uma base reproduzível, documentada e segura para iniciar as correções sem alterar dados reais ou o comportamento operacional do sistema.

## DIAGNÓSTICO VALIDADO

- Projeto Node.js CommonJS com Express 4.
- `server.js`: 3.733 linhas.
- `public/app.html`: 13.766 linhas.
- 169 declarações de rotas detectadas no entrypoint, além das rotas registradas pela fábrica de autenticação.
- Seis tenants: admin, panel, regina, portugal, felipe e ana.
- Persistência principal em JSON, JSONL, diretórios de mídia e sessão local do WhatsApp.
- 753 arquivos de dados, totalizando 149.421.378 bytes.
- O pacote contém arquivos com dados pessoais e pelo menos um arquivo de configuração com campo sensível. Valores não foram reproduzidos.
- O acesso atual é fail-open quando credenciais não estão configuradas.
- A conexão Cloud API é compartilhada e pode persistir segredo em arquivo.
- O webhook Meta não valida assinatura HMAC.
- O frontend unificado e o backend monolítico elevam o risco de regressão.
- O ZIP não continha diretório `.git`; foi criado um repositório local e a branch `fix/security-stability-zape-phase0` sem adicionar `data/` ao Git.

## ALTERAÇÕES REALIZADAS

- Criado `.env.example` com valores exclusivamente falsos.
- Criado inventário de variáveis de ambiente.
- Criada documentação da arquitetura e dos fluxos atuais.
- Adicionado `npm test` para executar todos os testes Node.
- Criado verificador de sintaxe compatível com CommonJS e com o `vite.config.js` em ESM.
- Criado validador informativo de configuração que não imprime valores.
- Criado gerador de fixture sintética para os seis tenants.
- Criado teste automatizado da fixture sintética.
- Criado gerador de checksums com hash do caminho para não expor nomes de arquivos.
- Atualizado `.gitignore` para permitir `.env.example` e excluir relatórios privados, temporários, backups e exports.
- Registrados checksums privados dos 753 arquivos antes de qualquer migração.

## ARQUIVOS ALTERADOS

- `package.json`
- `.gitignore`

## NOVOS ARQUIVOS

- `.env.example`
- `docs/architecture-current.md`
- `docs/environment-variables.md`
- `docs/phase-0-baseline.md`
- `scripts/check-syntax.js`
- `scripts/validate-config.js`
- `scripts/create-data-checksum-manifest.js`
- `scripts/create-sanitized-fixture.js`
- `tests/phase0Fixture.test.js`

## TESTES EXECUTADOS

### Instalação

1. `npm ci --no-audit --no-fund`
   - Resultado: falhou durante o script de instalação de `ffmpeg-static`.
   - Causa observada: falha DNS `EAI_AGAIN` ao acessar GitHub para baixar o binário.
   - Classificação: bloqueio de rede/instalação externa, não falha funcional comprovada do Zape.

2. `npm ci --ignore-scripts --no-audit --no-fund`
   - Resultado: aprovado.
   - 338 pacotes instalados.
   - Limitação: o binário empacotado de ffmpeg não foi baixado; o runtime pode usar `FFMPEG_PATH` ou ffmpeg do sistema.

### Sintaxe

- Verificação inicial com `node --check` identificou que `vite.config.js` usa ESM dentro de pacote CommonJS.
- O build do Vite aceita a configuração.
- Foi criado `npm run check:syntax`, que valida arquivos CommonJS normalmente e o Vite config como módulo.

### Testes existentes

- `npm run test:crm-integration`
- 5 testes executados.
- 5 aprovados.
- 0 falhas.

### Build web

- `npm run build:web`
- Resultado: aprovado.
- 10 módulos transformados.
- Build gerado em `dist/`.

### Boot com dados sintéticos

O projeto foi copiado para uma árvore isolada sem o diretório `data/` original. A fixture foi gerada nessa cópia e o servidor foi iniciado em porta temporária.

- `GET /health`: HTTP 200 com `{ "ok": true }`.
- `GET /admin` sem autenticação: HTTP 401.
- `POST /auth/login` com credenciais falsas: HTTP 200.
- `GET /admin` autenticado: HTTP 200.
- `GET /api/admin/leads` autenticado: HTTP 200.
- A resposta continha um único lead sintético com domínio `example.invalid`.
- WhatsApp Web, Cloud API e CRM externo permaneceram desabilitados.

### Auditoria de dependências

- `npm audit --omit=dev`
- Resultado: 10 vulnerabilidades.
- 1 crítica.
- 3 altas.
- 6 moderadas.
- Cadeias relevantes observadas: Express, `qs`, `path-to-regexp`, `whatsapp-web.js`, Puppeteer, `ws`, `basic-ftp`, `ip-address`, `js-yaml`, `minimatch` e `brace-expansion`.
- Nenhuma atualização foi aplicada nesta fase.

### Checksums

- 753 arquivos registrados.
- Total: 149.421.378 bytes.
- Manifesto redigido, sem nomes de arquivo em claro.
- SHA-256 agregado: `b1006ceb8283754493ad8fcbe40cdf433002ea37b433ee39d1a00bb53e33b4f6`.
- Manifesto privado exato também foi criado fora do repositório para validação e rollback local.

## RESULTADOS

- O projeto possui documentação inicial reproduzível.
- `npm test` passa a executar a suíte completa.
- Existe caminho automatizado para gerar dados sintéticos isolados.
- Existe validação de configuração sem exposição de segredo.
- Existe linha de base de integridade dos dados.
- O build web e os testes existentes funcionam com dependências instaladas sem scripts de lifecycle.
- A instalação totalmente reproduzível ainda depende de acesso ao binário externo do `ffmpeg-static` ou de estratégia alternativa.

## PROVAS DE ACEITAÇÃO

- `.env.example` existe e usa apenas valores falsos.
- `npm test` está definido como `node --test`.
- `scripts/create-sanitized-fixture.js` gera dados para seis tenants sem mídia real.
- `tests/phase0Fixture.test.js` valida que a fixture usa `example.invalid` e não contém domínios pessoais comuns.
- `npm run build:web` foi aprovado.
- Os cinco testes existentes do CRM externo foram aprovados.
- O teste adicional da fixture foi aprovado, totalizando 6 testes.
- O servidor iniciou em cópia isolada com dados sintéticos, autenticou e listou o lead de teste.
- Checksums foram gerados antes de qualquer alteração em `data/`.
- `git status --ignored` confirma que `data/`, `.env`, relatórios privados e temporários permanecem fora do versionamento.

## RISCOS RESTANTES

1. `npm ci` comum falha em ambiente sem acesso ao download do `ffmpeg-static`.
2. Dependências possuem vulnerabilidades conhecidas, incluindo uma crítica.
3. O servidor ainda inicia com autenticação fail-open.
4. Segredos ainda podem existir no pacote recebido e em arquivos de dados.
5. O servidor ainda usa dados reais quando executado na árvore original.
6. Cloud API, webhooks, CORS, XSS, CSRF, rate limit e HTTPS ainda não foram corrigidos.
7. O script de validação não bloqueia o boot nesta fase.
8. A fixture sintética precisa ser usada em uma cópia isolada do projeto porque os caminhos de dados ainda são fixos em `data/`.
9. Não foi realizado teste real de WhatsApp Web nem Cloud API, pois isso exigiria credenciais e infraestrutura de homologação.

## COMO FAZER ROLLBACK

Como o ZIP não continha histórico Git, o rollback deve ser feito na cópia de trabalho:

1. Remover os novos arquivos listados em `NOVOS ARQUIVOS`.
2. Restaurar `package.json` removendo os scripts `test`, `check:syntax`, `validate:config`, `fixture:sanitized` e `checksum:data`.
3. Remover o bloco final adicionado a `.gitignore`.
4. Apagar `node_modules/`, `dist/`, `tmp/` e `reports/private/`.
5. Validar que o hash agregado dos dados permanece igual ao baseline.
6. Em caso de dúvida, descartar a cópia de trabalho e extrair novamente o ZIP original.

Nenhum arquivo dentro de `data/` foi alterado, migrado, movido ou normalizado.

## COMMIT SUGERIDO

`chore(phase0): add baseline docs, synthetic fixtures and config validation`

## PRÓXIMA FASE

Fase 1. Contenção imediata de segredos e dados.

Não avançar sem autorização explícita.
