# Arquitetura atual do sistema Zape

Data da atualização: 14/07/2026

## 1. Visão geral

O Zape é uma aplicação Node.js CommonJS executada por um único processo Express. O backend, os workers locais, as integrações e a maior parte da lógica de negócio compartilham o mesmo processo e o mesmo sistema de arquivos.

Componentes principais:

- `server.js`: entrypoint e composição do monólito. Após a Fase 14 caiu de 4.668 para 3.756 linhas; rotas comuns ficam em `src/routes/`.
- `public/app.html`: shell unificado servido para os seis tenants. CSS, JavaScript, configuração de tenant e cliente HTTP estão separados em arquivos estáticos.
- `src/whatsappManager.js`: WhatsApp Web por tenant, sessões locais, mensagens e mídia.
- `src/waCloud.js`: integração oficial com a Meta.
- `src/externalCrmIntegration.js`: fila persistente e worker do CRM externo.
- Stores em `src/*Store.js`: leitura e escrita em JSON/JSONL.
- `data/`: fonte principal de dados operacionais, sessões e mídias.
- `ecosystem.config.cjs`: uma instância PM2 chamada `bobia`, em modo fork, com limite de memória, readiness e shutdown controlado.
- `nginx/casa-do-ads.conf`: terminação HTTPS, HSTS, limites por rota e proxy exclusivo para `127.0.0.1:3000`.

## 2. Processo de inicialização

1. `dotenv` carrega `.env`.
2. O boot valida autenticação e infraestrutura antes de criar o servidor.
3. Produção exige `HOST` em loopback, `PUBLIC_BASE_URL` HTTPS, proxy numérico e usuário não-root.
4. O Express aplica `trust proxy` com quantidade explícita de saltos, nunca `true`.
5. Helmet, CSP, CORS por allowlist, validação de origem e CSRF são registrados.
6. Endpoints públicos e rotas de mídia recebem parsers e limites próprios; o limite geral autenticado é de 16 MB.
7. As rotas de login, arquivos estáticos e APIs são registradas.
8. `migrateLegacyData()` copia alguns arquivos globais antigos para `data/admin` quando o destino não existe.
9. O servidor escuta em `127.0.0.1` por padrão e sinaliza readiness ao PM2.
10. O worker do CRM externo inicia no mesmo processo.
11. O WhatsApp Web pode iniciar em segundo plano para tenants com sessão local ou configuração elegível.
12. `SIGINT`, `SIGTERM` e a mensagem de shutdown do PM2 interrompem novas conexões e encerram workers e clientes WhatsApp.

## 3. Tenants

Tenants identificados:

- `admin`
- `panel`
- `regina`
- `portugal`
- `felipe`
- `ana`

Cada tenant possui prefixos próprios de API e diretório próprio em `data/<tenant>`. O frontend é o mesmo arquivo `public/app.html`, que identifica o tenant pela rota atual.

O isolamento agora é aplicado no backend por uma política central de autorização. Stores operacionais continuam separados por tenant. A conexão da Cloud API permanece global e compartilhada, mas sua configuração é exclusiva do `super_admin`; campanhas, planilhas e status são filtrados pelo tenant obtido da sessão.

## 4. Fluxo de autenticação atual

Arquivos:

- `src/authConfig.js`
- `src/basicAuthFactory.js`
- `src/sessionStore.js`
- `src/loginRateLimiter.js`
- `src/adminAuth.js`
- `src/panelAuth.js`
- `src/reginaAuth.js`
- `src/portugalAuth.js`
- `src/felipeAuth.js`
- `src/anaAuth.js`

Fluxo após a Fase 2:

1. O boot valida tenants habilitados, credenciais completas e `SESSION_SECRET` forte.
2. Tenant sem habilitação explícita ou sem credenciais completas permanece fechado com HTTP 403.
3. `POST /auth/login` aplica limitação por IP, tenant e combinação tenant/IP.
4. Credenciais são comparadas em tempo constante contra variáveis de ambiente.
5. O backend cria uma sessão persistente, armazena somente o hash do identificador e emite cookie HMAC.
6. O middleware aceita cookie ativo ou Basic Auth válido e monta `req.auth` com `userId`, `tenantId`, `role`, `permissions`, sessão e método.
7. A política central confere o tenant da rota e a permissão necessária. Rotas novas sob `/api/<tenant>` falham com 403 quando não possuem política.
8. Cookies inválidos, expirados, revogados ou de outro tenant são rejeitados.
9. `POST /auth/logout` revoga a sessão no servidor antes de apagar o cookie.

Propriedades de segurança implementadas:

- Não existe mais comportamento fail-open.
- `AUTH_SECRET` não é aceito como fallback.
- `SESSION_SECRET` não pode ser ausente, curto, previsível ou igual à senha de tenant.
- Cookies usam `HttpOnly`, `SameSite=Lax`, `Path=/`, `Priority=High` e `Secure` em produção.
- A sessão persistente fica fora do Git e contém somente hash do identificador.
- Respostas de falha de login são genéricas para reduzir enumeração.

Riscos remanescentes:

- O rate limiter é local ao processo e perde contadores após reinício.
- O store JSON de sessões pressupõe uma instância PM2 e não é apropriado para cluster.
- O modelo atual ainda possui um único usuário por tenant; múltiplos usuários individuais dependem da migração para banco.
- CSRF e hardening de navegador foram implementados na Fase 5.
- O rate limiter continua local ao processo, apesar do reforço adicional no Nginx.

## 5. Fluxo de leads

Entradas principais:

- `POST /api/leads`: formulário legado, desabilitado por padrão em produção; quando ativo exige token, limite de payload, rate limit e allowlist de campos.
- `POST /webhooks/activecampaign`: entrada fixa para `admin`, habilitada explicitamente, protegida por token forte, rate limit e idempotência.
- `POST /webhooks/:token`: resolve o tenant exclusivamente pelo registro do webhook, exige HMAC, timestamp e event ID, e ignora tentativas de alterar o tenant pelo payload.
- `POST /api/<tenant>/leads/manual`: criação manual autenticada.

Processamento:

1. `processLead()` normaliza telefone.
2. Cria ID aleatório e snapshot de origem.
3. Valida telefone e, conforme o fluxo, nome e e-mail.
4. `tenantLeadsStore.appendLead()` adiciona linha em `data/<tenant>/leads.jsonl`.
5. O fluxo pode incluir lead no CRM interno, enviar mensagem automática e enfileirar CRM externo.

Leitura:

- `GET /api/<tenant>/leads` usa `buildLeadsHandler()`.
- A consulta usa paginação real com até 500 itens por página.
- Existe deduplicação opcional por telefone.
- Tela, exportação, CRM e campanhas reutilizam a mesma interpretação de filtros e normalização.

## 6. Fluxo do CRM interno

Arquivo principal: `src/tenantCrmStore.js`.

- Estado completo salvo em `data/<tenant>/crm.json`.
- `GET /api/<tenant>/crm` lê o documento inteiro.
- `PUT /api/<tenant>/crm` substitui o estado e detecta entradas em etapas para mensagens automáticas.
- A atualização e o agendamento de mensagens não usam transação conjunta.
- Remoção de lead tenta retirar referências no CRM e em tags.

## 7. Fluxo do CRM externo

Arquivo principal: `src/externalCrmIntegration.js`.

- Fila padrão: `data/external_crm_queue.json`.
- Escrita usa arquivo temporário e `rename`, o que é mais seguro que sobrescrita direta.
- O worker roda no mesmo processo Express.
- Possui idempotência local por `eventKey`, tentativas, backoff e retenção de entregues.
- Há cinco testes automatizados, todos aprovados no baseline.
- A fila ainda depende de arquivo único e não possui lock entre processos.

## 8. Fluxo do WhatsApp Web

Arquivo principal: `src/whatsappManager.js`.

- Um manager é mantido em cache por tenant.
- Sessões ficam em `data/<tenant>/wwebjs_auth`.
- QR code, status, conversas, texto e áudio são expostos por rotas tenant-aware.
- Conversas persistem em `data/<tenant>/conversations.json`.
- Mídias persistem em `data/<tenant>/conversation_media`.
- Histórico local é limitado a 600 mensagens por conversa.
- Escrita de conversas usa cache em memória e debounce.
- O processo deve permanecer em uma instância enquanto sessões e arquivos forem locais.

## 9. Fluxo da WhatsApp Cloud API

Arquivos:

- `src/waCloud.js`
- `src/waCloudConfigStore.js`
- `src/waCloudConnection.js`
- `src/waCloudDispatchStore.js`
- `src/persistentJobQueue.js`
- `src/metaErrorHelper.js`
- rotas em `server.js`

Fluxo:

1. Configuração é combinada entre ambiente e `data/wa_cloud_config.json`.
2. A conexão, Embedded Signup, health check detalhado e desconexão são exclusivos do `super_admin`.
3. A conexão Meta continua global, mas recebe um `connectionId` estável derivado de `Phone Number ID + WABA ID`.
4. Cada campanha e cada disparo persistem `tenantId`, `connectionId`, `phoneNumberId`, `wabaId`, `campaignId`, `dispatchId`, `recipientId` e Meta message ID.
5. A resposta HTTP do envio muda o evento de `queued` para `submitted`; os estados `sent`, `delivered`, `read` e `failed` vêm do webhook oficial.
6. O índice `connectionId + Meta message ID` localiza o disparo exato e impede colisão entre conexões.
7. Respostas só são ligadas a uma campanha quando `context.id` aponta para a mensagem enviada dentro da mesma conexão e para o mesmo destinatário.
8. Respostas sem `context.id` ficam em `inboundEvents` como não correlacionadas. O sistema não usa mais telefone mais janela de sete dias para escolher campanha.
9. Transições são monotônicas: eventos fora de ordem ou repetidos não regridem `delivered`, `read` ou `replied`.
10. `POST /webhooks/wa-cloud` valida assinatura, schema, idempotência, `Phone Number ID` e WABA antes de processar.
11. `GET /api/wa-cloud/statuses` retorna somente eventos do tenant autenticado. O status legado global não é misturado nesse endpoint.
12. `GET /api/wa-cloud/health` confirma token, número, WABA, webhook e templates e traduz o erro `#133010` como número não registrado.

Estados suportados:

- `queued`
- `submitted`
- `sent`
- `delivered`
- `read`
- `failed`
- `replied`
- `expired`
- `canceled`

Riscos arquiteturais restantes:

- A conexão global continua sendo ponto único operacional.
- Campanhas retornam HTTP 202 e são processadas pelo worker persistente fora da requisição HTTP. O cursor e o progresso sobrevivem a reinícios.
- O store ainda é JSON local e exige uma única instância PM2.
- Respostas sem `context.id` ficam corretamente não correlacionadas, mas exigem tratamento operacional ou regra futura baseada em identificadores adicionais confiáveis.
- Homologação com uma conta Meta real ainda é necessária antes do deploy em produção.

## 10. Fluxo de webhooks

- `/debug/active`: ausente em produção; em desenvolvimento exige feature flag, `DEBUG=1`, autenticação do `admin` e papel `super_admin`.
- `POST /webhooks/activecampaign`: exige ativação explícita, token forte, payload limitado, rate limit e idempotência persistente.
- `POST /webhooks/:token`: token aleatório continua na URL para resolução, mas fica criptografado no disco; produção exige HMAC SHA-256, timestamp e event ID. O token não é copiado para lead, fila externa, log ou idempotência.
- `GET /webhooks/wa-cloud`: verificação Meta por verify token com comparação em tempo constante.
- `POST /webhooks/wa-cloud`: valida `X-Hub-Signature-256` sobre os bytes exatos do corpo, rejeita evento forjado, limita payload e frequência e evita reprocessar a mesma entrega.
- `data/webhook_idempotency.json`: mantém somente hashes e resultado técnico, sem payload, telefone, e-mail, token ou event ID bruto.

## 11. Persistência atual

Arquivos globais principais:

- `data/webhooks.json`
- `data/external_crm_queue.json`
- `data/wa_cloud_config.json`
- `data/wa_cloud_dispatches.json`
- `data/wa_cloud_jobs.json`
- `data/wa_cloud_message_status.json`

Arquivos por tenant:

- `leads.jsonl`
- `tags.json`
- `lead_tags.json`
- `crm.json`
- `message_status.json`
- `messageTemplate.json`
- `conversations.json`
- `wa_cloud_saved_sheets.json`
- `conversation_media/`
- `wwebjs_auth/`

Inventário físico do pacote recebido:

- 753 arquivos dentro de `data/`.
- 149.421.378 bytes no total.
- 534 arquivos `.ogg`.
- 149 arquivos `.jpg`.
- 19 arquivos `.json`.
- 18 arquivos `.webp`.
- 17 arquivos `.pdf`.
- 5 arquivos `.jsonl`.
- 5 arquivos `.mp4`.
- 5 arquivos `.xlsx`.
- 1 arquivo `.bak`.

Nenhum arquivo de dados foi alterado na Fase 0.

## 12. Arquivos executados ou diretamente referenciados

### Backend ativo

- `server.js`
- Todos os módulos importados diretamente pelo `server.js`.
- Dependências transitivas importadas por esses módulos.
- `ecosystem.config.cjs` no deploy PM2.
- `nginx/casa-do-ads.conf` no proxy entregue.

### Frontend ativo

- `public/app.html`, servido em `/admin`, `/panel`, `/regina`, `/portugal`, `/felipe` e `/ana`.
- `public/app.css` e `public/app.js`.
- `public/modules/app-config.js`: resolução do tenant, título, prefixo de API e idioma Cloud.
- `public/modules/api-client.js`: política comum de credenciais, cache e parsing JSON.
- `public/security-bootstrap.js`: Trusted Types, sanitização, URL segura e CSRF automático.
- Assets em `public/assets/ui-icons/`, `public/casadoads.png` e `public/favicon.ico`.

### Legados removidos na Fase 14

A remoção foi precedida por auditoria de referências, build e testes de regressão:

- `src/leadsStore.js`
- `src/leadTagsStore.js`
- `src/tagsStore.js`
- `src/messageStatusStore.js`
- `src/whatsapp.js`
- `public/admin.html`
- `public/panel.html`
- `public/regina.html`
- `public/index.html`

O Vite gera somente `public/app.html`. As URLs antigas continuam redirecionadas para a rota autenticada correspondente, sem depender dos arquivos removidos.

## 13. Infraestrutura atual

### PM2

- Uma aplicação: `bobia`.
- Uma instância explícita em modo `fork`.
- `wait_ready`, shutdown controlado e backoff de reinicialização.
- Limite padrão de memória em 1 GB.
- Logs direcionados para diretório operacional externo à aplicação.
- Cluster permanece bloqueado enquanto houver stores JSON e sessões locais do WhatsApp Web.

### Nginx

- Porta 80 usada para ACME e redirecionamento 301 para HTTPS.
- TLS 1.2 e 1.3 na porta 443, com HSTS após certificado válido.
- Proxy exclusivo para `127.0.0.1:3000`.
- Cabeçalhos encaminhados são reconstruídos pelo proxy; valores forjados pelo cliente não são confiados.
- Limites de corpo, conexão, frequência e timeout variam por rota.
- Hosts desconhecidos são rejeitados e tokens legados de webhook são mascarados nos logs.

## 14. Limites de arquitetura que afetam as próximas fases

- `server.js` e `public/app.html` concentram múltiplos domínios.
- Stores globais e por tenant usam escrita síncrona sem lock distribuído.
- Há dependência de sessão local do Chromium e mídia no mesmo servidor.
- O backend mistura HTTP, workers e automação de navegador no mesmo processo.
- Rotas comuns dos seis tenants são registradas por módulos tenant-aware; Cloud API e alguns endpoints públicos ainda permanecem no entrypoint.
- Não existe schema versionado para todos os arquivos.
- A autorização por papel e permissão foi centralizada na Fase 3, mas as rotas ainda permanecem concentradas no monólito.

## Atualização de segurança da Fase 1

- `src/secretVault.js` centraliza criptografia AES-256-GCM para segredos persistentes.
- `src/safeLog.js` mascara segredos e dados pessoais em logs.
- `src/waCloudConfigStore.js` grava App Secret e access token apenas em `encryptedSecrets`.
- `src/webhooksStore.js` grava tokens em formato criptografado e usa hash SHA-256 para localização.
- `scripts/migrate-secrets.js` realiza dry-run, backup, migração idempotente e rollback.
- `scripts/check-secrets.js` bloqueia padrões de segredos sem imprimir os valores.
- `scripts/export-sanitized-project.js` cria pacote sem dados, mídias, sessões, logs, backups ou arquivos `.env`.

As atualizações posteriores documentadas abaixo adicionam fail-closed, isolamento multi-tenant e assinatura de webhooks sem reescrever o monólito.

## Atualização de segurança da Fase 4

- `src/webhookSecurity.js` centraliza HMAC, comparação em tempo constante, validação estrutural, Content-Type, rate limit e proteção de timestamp.
- `src/webhookEventStore.js` adiciona idempotência persistente e atômica para formulário e webhooks.
- `src/publicEndpointConfig.js` valida tokens, flags e limites na preparação do ambiente.
- Parsers específicos dos endpoints públicos são executados antes do parser amplo das rotas autenticadas.
- Payloads públicos acima do limite retornam 413; formatos incorretos retornam 415; JSON inválido retorna 400.
- O rate limiter e o store de idempotência ainda pressupõem uma única instância. Redis, banco e lock distribuído pertencem às Fases 10 e 11.

## Hardening do navegador após a Fase 5

O frontend permanece funcionalmente monolítico, porém foi separado em arquivos estáticos para permitir CSP sem scripts inline:

```text
public/app.html
  -> public/app.css
  -> node_modules/@phosphor-icons/web/src/regular via /vendor/phosphor
  -> node_modules/dompurify/dist/purify.min.js via /vendor/dompurify.min.js
  -> public/security-bootstrap.js
  -> public/app.js
```

O fluxo de segurança de uma operação autenticada de escrita é:

```text
login válido
  -> cookie de sessão HttpOnly
  -> cookie CSRF SameSite=Strict
  -> frontend lê apenas o cookie CSRF
  -> wrapper fetch envia X-Zape-CSRF-Token
  -> servidor valida Origin/Referer
  -> servidor compara cookie e header
  -> middleware de autenticação e permissão
  -> handler da rota
```

Webhooks e formulário público não usam cookie CSRF. Eles continuam protegidos pelos mecanismos específicos da Fase 4.

A resposta HTTP passa por Helmet, CSP, cache privado, política de referência, anti-frame, nosniff e Permissions-Policy. HSTS está reservado para a implantação HTTPS da Fase 13.

## 14. Infraestrutura após a Fase 13

Fluxo de rede:

1. Internet acessa somente as portas 80 e 443 do Nginx.
2. HTTP serve o desafio ACME e redireciona para HTTPS.
3. HTTPS aplica TLS 1.2/1.3, HSTS, rejeição de host desconhecido, rate limit e limites de payload.
4. O Nginx substitui `X-Forwarded-For` pelo IP do socket externo e não encaminha `X-Forwarded-Host`.
5. O upstream é fixo em `127.0.0.1:3000`.
6. O Express confia em exatamente um salto de proxy.
7. PM2 executa uma única instância fork como usuário `zape`.
8. Dados, logs e backups ficam fora da pasta da release.

Arquivos operacionais:

- `nginx/zape-http.conf`
- `nginx/snippets/zape-proxy-common.conf`
- `nginx/casa-do-ads-bootstrap.conf`
- `nginx/casa-do-ads.conf`
- `deploy/install-infrastructure.sh`
- `deploy/configure-firewall.sh`
- `deploy/issue-certificate.sh`
- `deploy/verify-deploy.sh`

O Nginx usa um formato de log específico para webhooks que não registra o token legado da URL. O limite geral de 64 MB permanece temporário até a Fase 6.

## Segurança de mídia — Fase 6

A camada `src/mediaSecurity.js` valida magic bytes, MIME, extensão, pacote Office, tamanho e scanner opcional. Uploads de áudio e anexos são binários e transmitidos para arquivos temporários, sem conversão Base64 no frontend. `src/tenantConversationStore.js` cria IDs opacos, mantém a referência por mensagem e resolve o acesso pela combinação tenant + conversa + mensagem + mídia. O Nginx utiliza `zape-proxy-stream.conf` nas rotas de upload, com buffering desativado e limite de 26 MB.

## Fase 7 — Camada de integridade e migração

Foi adicionada uma camada central em `src/dataIntegrity.js` para auditar e migrar os arquivos legados sem alterar seus contratos de leitura antes da aplicação explícita.

Fluxo:

1. Os scripts `audit-*.js` leem os arquivos por tenant e produzem apenas contagens e hashes.
2. `migrate-data-integrity.js` cria um plano em dry-run.
3. Na aplicação, o script verifica se os arquivos continuam com os checksums usados no plano.
4. Cada arquivo alterado é copiado para backup antes da escrita atômica.
5. Registros incertos são gravados em `quarantine/<migrationId>/records.json`.
6. Mídias duplicadas ou órfãs só são movidas quando existe confirmação adicional.
7. Cada tenant recebe `.zape-data-manifest.json` com schema, hash e tamanho dos arquivos persistidos.
8. O boot valida JSON, JSONL e manifestos antes de abrir a porta. O modo estrito pode bloquear a inicialização.

A chave de unicidade de leads usada nesta fase é `tenantId + telefone normalizado`. Leads sem telefone permanecem independentes e não são consolidados automaticamente.


## Fase 8 — Paginação e edição de leads

A listagem de leads usa `src/leadQuery.js` para interpretar página, tamanho, ordenação e deduplicação. O backend aplica todos os filtros antes da contagem e retorna uma página de até 500 registros. Exportação, CRM e campanhas reutilizam a mesma API lógica; a exportação não pagina e os consumidores internos percorrem todas as páginas.

A edição passa por `src/leadService.js`, que valida os campos, exige a versão atual do lead e bloqueia telefone duplicado. `src/leadChangeStore.js` mantém a trilha de alterações em JSONL com o ator identificado por hash. O merge explícito atualiza leads, tags, CRM e funil como uma unidade reversível em memória; em falha, os arquivos envolvidos são restaurados.

## Persistência relacional — Fase 11

Foi adicionada uma camada de banco com driver PostgreSQL (`pg`), migrations versionadas, repositório de leads, importador JSON/JSONL, backup lógico e restauração. O boot aplica migrations e falha fechado quando `PERSISTENCE_MODE` exige banco e a conexão está indisponível.

No modo `database`, leads são carregados do banco no boot para manter compatibilidade com os fluxos síncronos existentes, mas toda criação, edição, merge e exclusão do domínio é confirmada transacionalmente no banco antes de atualizar o cache. O JSON não recebe novas gravações de leads após o cutover.

Os demais stores continuam em compatibilidade JSON apesar de já possuírem tabelas e importação. O corte completo será feito por repositório, sem dual-write permanente.

## Fase 12 — Observabilidade e privacidade

A aplicação passou a possuir uma camada de logs estruturados com correlação, registro de métricas, estado persistente de alertas, auditoria encadeada por hash, políticas de retenção, operações LGPD por tenant e backup criptografado com restauração verificada. O painel de monitoramento e a exportação Prometheus são restritos ao `super_admin`. A persistência principal continua seguindo os modos `json`, `shadow` e `database` definidos na Fase 11.


## Fase 14 — Dependências, modularização e legado

As rotas comuns foram divididas por domínio em `src/routes/tenant/`: interface, leads, CRM, WhatsApp Web, tags/templates e gestão de webhooks. `src/routes/healthRoutes.js`, `src/routes/businessRoutes.js` e `src/routes/adminMonitoringRoutes.js` retiram outros domínios do entrypoint. Um único loop registra a mesma superfície para os seis tenants, e a auditoria de políticas passou a ler também esses módulos.

O frontend iniciou uma divisão gradual com `public/modules/app-config.js` e `public/modules/api-client.js`. O arquivo `public/app.js` continua grande e deverá ser separado por leads, CRM, conversas e Cloud em fases futuras, sem nova reescrita total.

A cadeia de produção foi atualizada para Express 4.22.2 e whatsapp-web.js 1.34.7. O override `path-to-regexp@0.1.13` corrige a cadeia compatível do Express. O Vite foi atualizado para 8.1.4 e o build passou após a remoção de um fragmento de JavaScript inválido que havia sido copiado para `app.css`.

Qualidade progressiva:

- ESLint em módulos novos e extraídos.
- Prettier com verificação no CI local.
- TypeScript `checkJs` sobre `src/routes/**/*.js`.
- Auditoria de dependências diretas e de arquivos legados.
- Testes de registro das 25 rotas comuns por tenant.

O `npm audit --omit=dev` passou de 10 vulnerabilidades para zero sem `npm audit fix --force`. A auditoria completa offline também retornou zero após a atualização da cadeia de build.

## 19. Fase 15 — testes e homologação

A qualidade passa a ser verificada em quatro camadas adicionais:

- testes de API e isolamento dos seis tenants;
- testes de concorrência com coordenação de escrita por tenant;
- testes de navegador locais e E2E navegacional em CI/staging;
- carga e recuperação com fixtures sintéticas.

`src/leadWriteCoordinator.js` serializa gravações de leads no modo JSON por tenant. Essa proteção reduz duplicidades no processo atual, mas não substitui constraints do PostgreSQL nem permite múltiplas instâncias Node escrevendo no mesmo JSONL.

O ambiente de staging é gerado por script, usa PostgreSQL e Redis separados e mantém integrações externas desativadas por padrão. O pipeline CI está em `.github/workflows/ci.yml`.

## Controles de deploy da Fase 16

A aplicação possui identificação de release, feature flags por tenant e percentual, manifesto de arquivos, ativação atômica por symlink e endpoint administrativo de rollout. O health check informa a release efetivamente servida. Código e configuração podem ser revertidos por release; banco exige plano separado e forward fix quando houver dados posteriores.
