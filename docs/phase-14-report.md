# Relatório da Fase 14

## FASE EXECUTADA:

Fase 14. Dependências, modularização e código legado.

## OBJETIVO:

Reduzir vulnerabilidades corrigíveis, atualizar dependências em grupos controlados, diminuir duplicação entre tenants, iniciar a divisão do frontend, remover código comprovadamente sem uso e adicionar lint, formatação e type checking progressivo sem reescrever o sistema.

## DIAGNÓSTICO VALIDADO:

- O baseline possuía 10 vulnerabilidades de produção: 1 crítica, 3 altas e 6 moderadas.
- `server.js` possuía 4.668 linhas e aproximadamente 950 linhas repetidas entre seis tenants.
- `public/app.js` permanecia monolítico.
- Cinco stores e quatro HTMLs não participavam do runtime atual.
- As dependências diretas estavam em faixas amplas e algumas versões instaladas não coincidiam com a versão testada.
- O build antigo tolerava um fragmento de JavaScript copiado para `public/app.css`.
- Não havia ESLint, Prettier ou type checking progressivo configurados.

## ALTERAÇÕES REALIZADAS:

- Express fixado em 4.22.2.
- whatsapp-web.js fixado em 1.34.7.
- `path-to-regexp` atualizado para 0.1.13 por override compatível.
- Cadeias vulneráveis de desenvolvimento corrigidas com versões seguras de `minimatch`, `brace-expansion` e `picomatch`.
- Vite atualizado para 8.1.4.
- Nodemon atualizado para 3.1.14.
- Criados ESLint, Prettier e TypeScript `checkJs` progressivo.
- Rotas repetidas dos seis tenants substituídas por registradores por domínio.
- Health, páginas institucionais e monitoramento administrativo extraídos do entrypoint.
- Configuração do frontend e cliente HTTP extraídos para módulos próprios.
- Cinco stores e quatro HTMLs legados removidos após auditoria de referências.
- Auditorias automáticas de dependências diretas e arquivos legados adicionadas.
- Fragmento inválido de CSS corrigido.

## ARQUIVOS ALTERADOS:

- `server.js`
- `public/app.html`
- `public/app.js`
- `public/app.css`
- `package.json`
- `package-lock.json`
- `vite.config.js`
- `scripts/audit-tenant-route-policies.js`
- `docs/architecture-current.md`

Arquivos removidos:

- `src/leadsStore.js`
- `src/tagsStore.js`
- `src/leadTagsStore.js`
- `src/messageStatusStore.js`
- `src/whatsapp.js`
- `public/admin.html`
- `public/panel.html`
- `public/regina.html`
- `public/index.html`

## NOVOS ARQUIVOS:

- `src/routes/healthRoutes.js`
- `src/routes/businessRoutes.js`
- `src/routes/adminMonitoringRoutes.js`
- `src/routes/tenant/registerTenantPanelRoutes.js`
- `src/routes/tenant/uiRoutes.js`
- `src/routes/tenant/leadRoutes.js`
- `src/routes/tenant/crmRoutes.js`
- `src/routes/tenant/whatsappWebRoutes.js`
- `src/routes/tenant/contentRoutes.js`
- `src/routes/tenant/webhookManagementRoutes.js`
- `public/modules/app-config.js`
- `public/modules/api-client.js`
- `scripts/audit-code-usage.js`
- `scripts/audit-direct-dependencies.js`
- `scripts/smoke-phase14.js`
- `tests/tenantRouteRegistry.test.js`
- `tests/frontendModules.test.js`
- `tests/legacyRemoval.test.js`
- `eslint.config.cjs`
- `.prettierrc.json`
- `.prettierignore`
- `tsconfig.phase14.json`
- documentação e evidências da fase.

## TESTES EXECUTADOS:

- `npm ci --ignore-scripts --no-audit --no-fund`
- `npm run quality`
- `npm run check:syntax`
- `npm test`
- `npm run build:web`
- `npm run audit:permissions`
- `npm run audit:frontend-security`
- `npm run audit:dependencies`
- `node scripts/audit-code-usage.js`
- `npm run security:scan`
- smoke tests das Fases 5, 6, 8, 9, 10, 11, 12, 13 e 14.
- audit de produção e completo em modo offline.

## RESULTADOS:

- 137 testes aprovados e zero falhas.
- 162 arquivos JavaScript aprovados na verificação de sintaxe.
- 210 rotas tenant-aware auditadas e zero rotas sem política.
- Build aprovado com Vite 8.1.4.
- Qualidade, formatação e type checking aprovados.
- Nenhuma dependência direta sem evidência de uso.
- Nenhum dos nove arquivos legados removidos voltou a aparecer no runtime.
- `server.js` caiu de 4.668 para 3.756 linhas, redução de 912 linhas.
- `npm audit --omit=dev` caiu de 10 vulnerabilidades para zero após a atualização da cadeia de produção.
- A árvore final não contém as versões vulneráveis de `minimatch@10.2.2`, `brace-expansion@5.0.2` ou `picomatch@2.3.1`.
- O audit completo e de produção offline retornaram zero vulnerabilidades.
- O endpoint online de audit ficou intermitente e retornou HTTP 502 na última repetição; essa indisponibilidade está preservada nas evidências.

## PROVAS DE ACEITAÇÃO:

- Os seis tenants autenticaram e responderam aos mesmos seis grupos de endpoints no smoke test.
- Cada tenant recebe 25 rotas comuns por um único registrador.
- URLs HTML antigas continuam redirecionando para as rotas autenticadas.
- Express 4.22.2 foi confirmado em runtime.
- whatsapp-web.js 1.34.7 carregou `Client`, `LocalAuth` e `MessageMedia`.
- O build antigo deixou de mascarar o CSS inválido; Vite 8 compilou o arquivo corrigido.
- A instalação limpa adicionou 457 pacotes em aproximadamente cinco segundos usando cache e scripts de instalação desativados.
- O ffmpeg do sistema foi resolvido quando o binário empacotado não estava disponível.
- Nenhum dado real foi aberto, migrado ou alterado.

## RISCOS RESTANTES:

- `server.js` ainda possui 3.756 linhas e concentra Cloud API, endpoints públicos e composição operacional.
- `public/app.js` ainda possui 8.249 linhas; leads, CRM, conversas e Cloud precisam de extração gradual.
- O build mantém scripts clássicos sem `type="module"` e resolve alguns assets somente em runtime.
- `fluent-ffmpeg` e `glob@10.5.0` são dependências transitivas depreciadas da cadeia do whatsapp-web.js.
- O binário do `ffmpeg-static` depende de download durante os scripts de instalação; o ambiente atual usou `/usr/bin/ffmpeg`.
- O WhatsApp Web real deve ser homologado em staging com sessão e número exclusivos.
- Cloud API real continua exigindo credenciais e número de teste da Meta.
- O type checking ainda não cobre integralmente `server.js` e `public/app.js`.

## COMO FAZER ROLLBACK:

Reverter os commits da fase em ordem inversa, executar `npm ci --ignore-scripts` e repetir testes e smoke tests. Antes de voltar a arquivos HTML legados, confirmar que o proxy e o cache não estão servindo versões antigas. Manter `FFMPEG_PATH` apontando para um binário operacional quando os scripts do `ffmpeg-static` não puderem baixar o artefato.

## COMMIT SUGERIDO:

- `fix(deps): update secure runtime and build toolchain`
- `refactor(core): register tenant routes by domain`
- `chore(legacy): remove unused code and document phase 14`

## PRÓXIMA FASE:

Fase 15. Testes automatizados e homologação. Não iniciada.
