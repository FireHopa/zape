# Variáveis de ambiente atuais do Zape

Data do inventário: 13/07/2026

Este documento descreve o comportamento observado no código atual. Ele não altera a configuração em produção. Valores reais não foram copiados para este documento.

## Regras gerais

- Use `.env.example` apenas como modelo.
- Nunca versionar `.env`, tokens, senhas, cookies, IDs de conta associados a clientes ou dados pessoais.
- Em desenvolvimento e testes, use exclusivamente credenciais falsas e domínios `example.invalid`.
- A autenticação opera em modo fail-closed. Tenant desabilitado ou com credenciais incompletas não libera rotas.
- `SESSION_SECRET` é obrigatório sempre que existir tenant habilitado e não possui alias ou fallback.
- App Secret, token da Cloud API e tokens de webhooks persistidos usam AES-256-GCM com `CONFIG_ENCRYPTION_KEY`.

## Runtime e URLs

| Variável | Estado atual | Finalidade | Observação |
|---|---|---|---|
| `NODE_ENV` | Opcional | Define ambiente | PM2 usa `production`. O servidor não faz validação completa por ambiente. |
| `PORT` | Opcional | Porta HTTP do Express | Padrão atual: `3000`. |
| `DEBUG` | Opcional | Ativa logs de requisição e logs de WhatsApp | Evitar em produção sem mascaramento adicional. |
| `DEBUG_AUTH` | Opcional | Controla resumo de tentativas de login | Usuário e IP são registrados apenas como fingerprints. |
| `AUDIO_DEBUG` | Opcional | Logs do fluxo de áudio | Segredos e conteúdo Base64 são mascarados. Reduzir ou desativar em produção. |
| `PUBLIC_BASE_URL` | Recomendado em produção | URL pública usada em webhooks e links | Deve ser HTTPS em produção. |
| `APP_BASE_URL` | Alias legado | Fallback de `PUBLIC_BASE_URL` | Não configurar ambos com valores diferentes. |

## Sessões e tenants

| Variável | Estado | Finalidade |
|---|---|---|
| `SESSION_SECRET` | Obrigatória com tenant habilitado | Assina cookies. Mínimo de 32 caracteres, alta diversidade e independente das senhas. |
| `SESSION_STORE_FILE` | Opcional | Caminho do JSON persistente de sessões. Padrão: `data/auth_sessions.json`. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | Opcional | Janela de contagem. Padrão: 15 minutos. |
| `AUTH_RATE_LIMIT_BLOCK_MS` | Opcional | Duração do bloqueio temporário. Padrão: 15 minutos. |
| `AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS` | Opcional | Limite global por IP. Padrão: 12. |
| `AUTH_RATE_LIMIT_TENANT_IP_MAX_ATTEMPTS` | Opcional | Limite por tenant e IP. Padrão: 6. |
| `AUTH_RATE_LIMIT_TENANT_MAX_ATTEMPTS` | Opcional | Limite agregado por tenant. Padrão: 120. |
| `AUTH_TRUST_PROXY_HEADERS` | Desabilitada por padrão | Permite usar `X-Forwarded-For` no rate limiter somente atrás de proxy confiável. |

Cada tenant possui três variáveis:

| Tenant | Habilitação | Credenciais |
|---|---|---|
| `admin` | `ADMIN_ENABLED` | `ADMIN_USER` / `ADMIN_PASS` |
| `panel` | `PANEL_ENABLED` | `PANEL_USER` / `PANEL_PASS` |
| `regina` | `REGINA_ENABLED` | `REGINA_USER` / `REGINA_PASS` |
| `portugal` | `PORTUGAL_ENABLED` | `PORTUGAL_USER` / `PORTUGAL_PASS` |
| `felipe` | `FELIPE_ENABLED` | `FELIPE_USER` / `FELIPE_PASS` |
| `ana` | `ANA_ENABLED` | `ANA_USER` / `ANA_PASS` |

Regras:

- `*_ENABLED=1` exige usuário e senha completos e aborta o boot quando o par estiver incompleto.
- Quando `*_ENABLED` não existe, a presença de qualquer parte do par indica intenção de habilitar; par incompleto também falha.
- `*_ENABLED=0` mantém o tenant fechado, mesmo que exista cookie antigo.
- `AUTH_SECRET` é legado e não é aceito.
- O arquivo de sessões armazena hash do identificador, tenant, usuário, expiração e revogação. O identificador bruto permanece apenas no cookie assinado.

## WhatsApp Web

| Variável | Padrão observado | Finalidade |
|---|---|---|
| `WEBJS_ENABLED` | Desabilitado salvo valor `1` | Habilita `whatsapp-web.js`. |
| `WEBJS_AUTO_START` | Automático salvo valor falso explícito | Controla inicialização após boot. |
| `WEBJS_AUTO_START_TENANTS` | Descoberta por sessão local | Lista separada por vírgulas. |
| `WEBJS_HEADLESS` | Ativo | Executa Chromium sem interface. |
| `WEBJS_NO_SANDBOX` | Desabilitado | Adiciona flags sem sandbox. Deve permanecer desabilitado quando possível. |
| `WEBJS_WEB_VERSION` | Vazio | Fixa versão do WhatsApp Web. |
| `WEBJS_REMOTE_CACHE` | Desabilitado | Ativa cache remoto de versão. |
| `WEBJS_REMOTE_PATH` | Vazio | Template de caminho remoto. |
| `WEBJS_REMOTE_STRICT` | Desabilitado | Exige cache remoto. |
| `WEBJS_DEFAULT_TEMPLATE_TEXT` | Vazio | Template padrão de mensagem. |
| `WEBJS_SESSION` | `lead-bot` | Usado somente no módulo legado `src/whatsapp.js`. |
| `CHROME_EXECUTABLE_PATH` | Descoberta automática | Caminho do Chromium/Chrome. |
| `FFMPEG_PATH` | Descoberta automática | Caminho do ffmpeg. |
| `WA_READY_TIMEOUT_MS` | `60000` | Timeout para cliente ficar pronto. |
| `WA_AUTH_WATCHDOG_MS` | `60000` | Limite do watchdog de autenticação. |
| `WA_AUTH_WATCHDOG_INTERVAL_MS` | `2000` | Intervalo do watchdog. |

## CRM externo

| Variável | Padrão observado | Finalidade |
|---|---|---|
| `CRM_INTEGRATION_ENABLED` | Ativo por padrão, mas exige URL e chave | Liga integração externa. |
| `CRM_INTEGRATION_URL` | Vazio | Base URL do CRM. |
| `CRM_INTEGRATION_KEY` | Vazio | Chave de autenticação. Segredo. |
| `CRM_INTEGRATION_TIMEOUT_MS` | `15000` | Timeout HTTP. |
| `CRM_INTEGRATION_MAX_ATTEMPTS` | `6` | Tentativas totais aproximadas. |
| `CRM_INTEGRATION_WORKER_INTERVAL_MS` | `30000` | Intervalo do worker persistente. |
| `EXTERNAL_CRM_QUEUE_FILE` | `data/external_crm_queue.json` | Caminho alternativo da fila. |
| `CRM_INTEGRATION_ACTIVE_CAMPAIGN_TO_CRM_ENABLED` | Compatibilidade | Controla repasse da entrada ActiveCampaign ao CRM. |
| `CRM_INTEGRATION_ACTIVE_CAMPAIGN_PIPELINE_ID` | Vazio | Pipeline de destino. |
| `CRM_INTEGRATION_ACTIVE_CAMPAIGN_STAGE_ID` | Vazio | Etapa de destino. |
| `CRM_INTEGRATION_ACTIVE_CAMPAIGN_SOURCE` | `WhatsApp` | Origem normalizada. |

## WhatsApp Cloud API e Embedded Signup

Variáveis primárias:

| Variável | Finalidade |
|---|---|
| `WA_CLOUD_ENABLED` | Habilita a integração oficial. |
| `WA_CLOUD_GRAPH_VERSION` | Versão da Graph API. Padrão atual: `v25.0`. |
| `WA_CLOUD_FORCE_ENV` | Força uso do conjunto do ambiente em vez da conexão salva. |
| `WA_CLOUD_TOKEN` | Access token. Segredo. |
| `WA_CLOUD_PHONE_NUMBER_ID` | ID do número oficial. |
| `WA_CLOUD_WABA_ID` | ID da conta WhatsApp Business. |
| `WA_CLOUD_WEBHOOK_VERIFY_TOKEN` | Token usado na verificação GET do webhook. Segredo operacional. |
| `WA_CLOUD_CONNECTION_OWNER_TENANT` | Tenant responsável pela conexão global. Aceita `admin`, `panel`, `regina`, `portugal`, `felipe` ou `ana`. Padrão: `admin`. |
| `WA_CLOUD_GRAPH_BASE_URL` | Base alternativa usada somente em testes ou homologação local. É ignorada em `NODE_ENV=production` para impedir redirecionamento da integração oficial. |
| `WA_EMBEDDED_APP_ID` | App ID do Embedded Signup. |
| `WA_EMBEDDED_APP_SECRET` | App Secret. Segredo. |
| `WA_EMBEDDED_CONFIG_ID` | Configuration ID do login. |
| `WA_EMBEDDED_REDIRECT_URI` | URI de redirecionamento. |

Aliases aceitos pelo código atual:

- `META_WA_ACCESS_TOKEN`
- `META_WA_PHONE_NUMBER_ID`
- `META_WA_WABA_ID`
- `META_WA_FORCE_ENV`
- `META_GRAPH_VERSION`
- `META_APP_ID`
- `META_APP_SECRET`
- `META_LOGIN_CONFIG_ID`
- `META_REDIRECT_URI`
- `FACEBOOK_APP_ID`
- `FACEBOOK_APP_SECRET`
- `FACEBOOK_LOGIN_CONFIG_ID`
- `FACEBOOK_REDIRECT_URI`

Não configure variáveis primárias e aliases com conjuntos diferentes. Quando o painel precisa persistir credenciais, o arquivo local guarda apenas envelopes criptografados. Formatos legados em texto puro são bloqueados por padrão e devem ser migrados.


## Cofre de segredos e migração

| Variável | Estado | Finalidade |
|---|---|---|
| `CONFIG_ENCRYPTION_KEY` | Obrigatória para persistência segura | Chave de 32 bytes em Base64 ou 64 caracteres hexadecimais usada por AES-256-GCM. |
| `ALLOW_LEGACY_PLAINTEXT_SECRETS` | Deve permanecer `0` | Compatibilidade emergencial e temporária para leitura de JSON legado em texto puro. |
| `ZAPE_DATA_DIR` | Opcional | Direciona stores e scripts compatíveis para uma cópia isolada de dados em testes e migrações. |

A chave de criptografia não deve ser reutilizada entre desenvolvimento, staging e produção. A troca da chave exige recriptografia controlada dos segredos.

## Validação adicionada na Fase 0

Comando informativo:

```bash
npm run validate:config
```

Validação estrita para preparação de produção:

```bash
node scripts/validate-config.js --mode=production --strict
```

O script não imprime valores. Ele apenas informa nomes ausentes, grupos parciais e riscos. Nesta fase, ele não é executado automaticamente no boot para não alterar o comportamento de produção antes da Fase 2.

## Papéis e auditoria adicionados na Fase 3

Cada tenant aceita uma variável opcional de papel:

| Tenant | Variável | Padrão |
|---|---|---|
| `admin` | `ADMIN_ROLE` | `super_admin` |
| `panel` | `PANEL_ROLE` | `tenant_admin` |
| `regina` | `REGINA_ROLE` | `tenant_admin` |
| `portugal` | `PORTUGAL_ROLE` | `tenant_admin` |
| `felipe` | `FELIPE_ROLE` | `tenant_admin` |
| `ana` | `ANA_ROLE` | `tenant_admin` |

Valores aceitos: `super_admin`, `tenant_admin`, `operator` e `viewer`.

`super_admin` é reservado ao tenant `admin`. Uma role inválida ou a tentativa de atribuir `super_admin` a outro tenant bloqueia o boot.

| Variável | Estado | Finalidade |
|---|---|---|
| `SECURITY_AUDIT_FILE` | Opcional | Caminho do JSONL de auditoria administrativa. Padrão: `data/security_audit.jsonl`. |

O arquivo de auditoria não grava nome de usuário em texto puro. O ator é representado por hash SHA-256, tenant e papel.

## Segurança de endpoints públicos adicionada na Fase 4

| Variável | Padrão seguro | Finalidade |
|---|---|---|
| `PUBLIC_LEAD_FORM_ENABLED` | Desabilitado em produção | Reativa explicitamente o formulário público legado. |
| `PUBLIC_LEAD_FORM_TOKEN` | Vazio | Token de 32+ caracteres exigido em produção quando o formulário estiver ativo. Enviar em `X-Zape-Webhook-Token` ou `Authorization: Bearer`. |
| `ACTIVECAMPAIGN_WEBHOOK_ENABLED` | Desabilitado em produção | Habilita o webhook fixo da ActiveCampaign. |
| `ACTIVECAMPAIGN_WEBHOOK_TOKEN` | Vazio | Token de 32+ caracteres obrigatório quando a integração estiver habilitada. |
| `CUSTOM_WEBHOOK_REQUIRE_SIGNATURE` | `1` | Exige HMAC SHA-256 nos webhooks gerados. Em produção não pode ser desativado. |
| `CUSTOM_WEBHOOK_CLOCK_TOLERANCE_SECONDS` | `300` | Tolerância máxima entre o timestamp assinado e o relógio do servidor. Intervalo aceito: 30 a 3.600 segundos. |
| `ALLOW_WEBHOOK_TOKEN_IN_QUERY` | `0` | Compatibilidade excepcional com token em query. Evitar porque URLs podem aparecer em logs e histórico. |
| `PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS` | `0` | Permite usar `X-Forwarded-For` no rate limit. Só habilitar após restringir o proxy confiável. |
| `PUBLIC_FORM_BODY_LIMIT` | `250kb` | Limite do formulário público. |
| `PUBLIC_WEBHOOK_BODY_LIMIT` | `500kb` | Limite do ActiveCampaign e dos webhooks customizados. |
| `META_WEBHOOK_BODY_LIMIT` | `1mb` | Limite do webhook oficial da Meta. |
| `PUBLIC_RATE_LIMIT_WINDOW_MS` | `60000` | Janela comum de rate limiting dos endpoints públicos. |
| `PUBLIC_FORM_RATE_LIMIT_MAX` | `20` | Máximo de requisições do formulário por identidade e janela. |
| `ACTIVECAMPAIGN_RATE_LIMIT_MAX` | `120` | Máximo do webhook fixo por identidade e janela. |
| `CUSTOM_WEBHOOK_RATE_LIMIT_MAX` | `120` | Máximo por IP, tenant e webhook. |
| `META_WEBHOOK_RATE_LIMIT_MAX` | `600` | Máximo do endpoint Meta por IP. |
| `WEBHOOK_IDEMPOTENCY_FILE` | `data/webhook_idempotency.json` | Arquivo persistente com hashes dos eventos processados. |
| `WEBHOOK_IDEMPOTENCY_RETENTION_MS` | 7 dias | Retenção dos resultados idempotentes. |
| `WEBHOOK_IDEMPOTENCY_PENDING_TIMEOUT_MS` | 15 minutos | Prazo para liberar um evento que ficou pendente após interrupção. |
| `ENABLE_DEBUG_ACTIVE` | `0` | Permite a rota de diagnóstico apenas fora de produção, com `DEBUG=1` e autenticação `super_admin`. |

### Cabeçalhos dos webhooks customizados

Cada requisição para `/webhooks/<token>` deve enviar:

- `Content-Type: application/json` ou `application/x-www-form-urlencoded`
- `X-Zape-Timestamp`: Unix timestamp em segundos ou milissegundos
- `X-Zape-Event-Id`: identificador único do evento
- `X-Zape-Signature`: `sha256=<hmac hexadecimal>`

A assinatura usa o token do webhook como segredo e o seguinte conteúdo, sem espaços adicionais:

```text
<timestamp>.<eventId>.<raw body>
```

O token continua sendo usado na URL para localização do webhook, mas não é copiado para leads, filas externas, logs ou arquivos de idempotência.

### Webhook da Meta

`POST /webhooks/wa-cloud` exige `X-Hub-Signature-256`. O HMAC é calculado sobre os bytes exatos do corpo usando o App Secret disponível no ambiente ou no cofre local. Ausência de App Secret, assinatura ausente ou assinatura inválida fazem o endpoint falhar fechado antes de processar qualquer status ou mensagem.

## Segurança do navegador adicionada na Fase 5

| Variável | Padrão | Finalidade |
|---|---|---|
| `APP_ALLOWED_ORIGINS` | Vazio | Lista de origens extras permitidas por CORS e validação de origem, separadas por vírgulas. Same-origin não precisa ser listado. |
| `CORS_ALLOWED_ORIGINS` | Alias opcional | Alias legado de `APP_ALLOWED_ORIGINS`. Não configure os dois com listas diferentes. |

Exemplo:

```env
APP_ALLOWED_ORIGINS=https://painel.example.com,https://operacao.example.com
```

Regras:

- informe origens completas, sem caminhos;
- use HTTPS em produção;
- não use `*`;
- não inclua domínios de terceiros que não precisem operar o painel;
- alterações exigem reinício do processo;
- o token CSRF é criado automaticamente durante o login e não deve ser configurado no ambiente.

A CSP é definida no código e não possui modo permissivo por variável de ambiente. HSTS é publicado pelo Nginx após a ativação do HTTPS na Fase 13.

## Infraestrutura adicionada na Fase 13

| Variável | Produção recomendada | Finalidade |
|---|---|---|
| `HOST` | `127.0.0.1` | Endereço de bind do Express. Produção rejeita endereços não-loopback. |
| `PORT` | `3000` | Porta privada do Node. |
| `TRUST_PROXY_HOPS` | `1` | Quantidade explícita de proxies confiáveis. Valores booleanos e `true` irrestrito são rejeitados. |
| `PUBLIC_BASE_URL` | `https://bobia.com.br` | URL canônica. HTTPS é obrigatório em produção. |
| `AUTH_TRUST_PROXY_HEADERS` | `1` | Faz o rate limit de login usar `req.ip` calculado pelo Express. |
| `PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS` | `1` | Faz o rate limit público usar `req.ip` calculado após a política de proxy. |
| `INFRA_ALLOW_ROOT_PROCESS` | `0` | Exceção explícita apenas para testes controlados. O boot recusa root em produção. |
| `INFRA_ALLOW_HTTP_FOR_TESTS` | `0` | Exceção apenas para smoke local em loopback com `NODE_ENV=production`. |
| `ZAPE_APP_DIR` | `/opt/zape/current` | Diretório da release usado pelo PM2. |
| `ZAPE_LOG_DIR` | `/var/log/zape` | Diretório dos logs do processo. |
| `ZAPE_BACKUP_DIR` | `/var/backups/zape` | Diretório recomendado para backups locais criptografados. |
| `ZAPE_MAX_MEMORY` | `1G` | Limite de memória para restart controlado pelo PM2. |
| `VALIDATE_RUNTIME_UID` | `1001` no CI | UID alvo usado apenas pelo validador de configuração; o boot usa o UID real. |

Regras obrigatórias:

- não configure `HOST=0.0.0.0` em produção;
- não configure `TRUST_PROXY_HOPS=true`;
- não habilite confiança em cabeçalhos de proxy sem o Nginx restrito;
- o Nginx deve substituir `X-Forwarded-For`, não concatenar o valor recebido;
- o processo PM2 deve ser iniciado pelo usuário `zape`;
- o `.env` deve usar permissão `0600`;
- HSTS só deve ser publicado depois de certificado e HTTPS validados.

## Segurança de mídias adicionada na Fase 6

| Variável | Padrão | Finalidade |
|---|---:|---|
| `AUTHENTICATED_BODY_LIMIT` | `16mb` | Limite do parser JSON e URL encoded. Uploads de mídia não usam esse parser. |
| `MEDIA_ABSOLUTE_MAX_BYTES` | 25 MB | Teto absoluto do upload binário transmitido ao disco temporário. |
| `MEDIA_AUDIO_MAX_BYTES` | 10 MB | Limite específico para áudio. |
| `MEDIA_IMAGE_MAX_BYTES` | 12 MB | Limite específico para imagem. |
| `MEDIA_VIDEO_MAX_BYTES` | 25 MB | Limite específico para vídeo. |
| `MEDIA_PDF_MAX_BYTES` | 20 MB | Limite específico para PDF. |
| `MEDIA_DOCUMENT_MAX_BYTES` | 20 MB | Limite para documentos de texto e Office. |
| `MEDIA_SPREADSHEET_MAX_BYTES` | 20 MB | Limite para planilhas. |
| `MEDIA_PRESENTATION_MAX_BYTES` | 20 MB | Limite para apresentações. |
| `MEDIA_ARCHIVE_MAX_BYTES` | 15 MB | Limite para ZIP. |
| `MEDIA_TEXT_MAX_BYTES` | 2 MB | Limite para TXT e CSV. |
| `MEDIA_SCANNER_COMMAND_JSON` | Vazio | Array JSON com executável e argumentos do scanner. O caminho temporário é acrescentado como último argumento. |
| `MEDIA_SCANNER_REQUIRED` | `0` | Quando `1`, upload falha fechado se o scanner estiver ausente ou indisponível. |
| `MEDIA_SCANNER_TIMEOUT_MS` | `30000` | Timeout da verificação antimalware. |
| `MEDIA_ORPHAN_RETENTION_DAYS` | `30` | Idade mínima para uma mídia órfã entrar no plano de quarentena. |

Exemplo com ClamAV:

```env
MEDIA_SCANNER_COMMAND_JSON=["clamdscan","--no-summary"]
MEDIA_SCANNER_REQUIRED=1
```

Os limites do Nginx são 26 MB apenas nas rotas binárias de áudio e anexos. O restante das rotas autenticadas usa 16 MB. O backend ainda aplica o limite menor correspondente ao tipo real identificado pelos magic bytes.

## Fase 7 — Integridade de dados

| Variável | Padrão | Uso |
|---|---|---|
| `DATA_INTEGRITY_VALIDATE_ON_BOOT` | `1` | Executa validação somente leitura de JSON, JSONL e manifestos antes do servidor abrir a porta. |
| `DATA_INTEGRITY_STRICT_BOOT` | `0` | Quando `1`, bloqueia o boot se houver corrupção, linha inválida ou divergência de checksum em manifesto existente. Ativar depois da migração controlada. |
| `LEADS_INVALID_LINE_QUARANTINE` | `1` | Copia linhas inválidas detectadas em leitura para quarentena protegida, sem removê-las do arquivo original. A remoção do original ocorre apenas pela migração confirmada. |

Os scripts de auditoria e migração recebem o diretório por `--data-dir` ou usam `ZAPE_DATA_DIR`. A aplicação exige `--apply --confirm=APPLY_DATA_INTEGRITY`; o rollback exige `--confirm=ROLLBACK_DATA_INTEGRITY`.


### Health check da Cloud API

`GET /api/wa-cloud/health` exige autenticação de `super_admin` e valida, sem devolver tokens:

- presença das credenciais;
- versão da Graph API;
- acesso ao Phone Number ID;
- indício de registro do número;
- acesso ao WABA;
- inscrição do aplicativo no webhook;
- consulta de templates;
- validade do token.

Resposta saudável usa HTTP 200. Configuração incompleta ou dependência externa inválida usa HTTP 424, com erro operacional normalizado.


## Fila de campanhas da Cloud API

| Variável | Uso |
|---|---|
| `WA_CLOUD_QUEUE_POLL_MS` | Intervalo de leitura da fila persistente. Padrão: `250`. |
| `WA_CLOUD_QUEUE_MAX_ATTEMPTS` | Máximo de tentativas por destinatário para falhas transitórias. Padrão: `5`. |
| `WA_CLOUD_QUEUE_RETRY_BASE_MS` | Base do backoff exponencial. Padrão: `1000`. |
| `WA_CLOUD_QUEUE_RETRY_MAX_MS` | Teto do backoff. Padrão: `60000`. |
| `WA_CLOUD_CAMPAIGN_MAX_CONTACTS` | Limite de contatos aceitos por campanha. Padrão: `10000`. |

## Persistência relacional — Fase 11

| Variável | Obrigatória | Descrição |
|---|---:|---|
| `PERSISTENCE_MODE` | sim | `json`, `shadow` ou `database` |
| `DATABASE_URL` | em shadow/database | URL PostgreSQL. SQLite somente em testes |
| `DATABASE_SSL` | produção | `require`, `no-verify` ou `disable` |
| `DATABASE_POOL_MAX` | não | Máximo de conexões, padrão 10 |
| `DATABASE_STATEMENT_TIMEOUT_MS` | não | Timeout de query, padrão 15000 |
| `DATABASE_IDLE_TIMEOUT_MS` | não | Timeout de conexão ociosa, padrão 30000 |
| `DATABASE_CONNECTION_TIMEOUT_MS` | não | Prazo máximo para abrir conexão; padrão 5000 e mínimo 500 |
| `PERSISTENCE_SHADOW_UNTIL` | em shadow | Data final obrigatória |
| `PERSISTENCE_SHADOW_OWNER` | em shadow | Responsável pelo corte |

Produção bloqueia SQLite. O modo shadow também bloqueia o boot quando o prazo expira.

## Fase 12 — Observabilidade, backup e LGPD

- `LOG_LEVEL`: nível mínimo do logger estruturado.
- `STRUCTURED_LOG_FILE`: arquivo JSONL de logs.
- `STRUCTURED_LOG_MAX_BYTES`: tamanho para rotação.
- `STRUCTURED_LOG_MAX_FILES`: quantidade de arquivos rotacionados.
- `SECURITY_AUDIT_FILE`: trilha de auditoria encadeada.
- `MONITOR_INTERVAL_MS`: intervalo do monitor interno.
- `ALERT_COOLDOWN_MS`: cooldown entre notificações iguais.
- `ALERT_WEBHOOK_URL`: webhook opcional para alertas.
- `ALERT_WEBHOOK_TOKEN`: token opcional do webhook de alertas.
- `ALERT_STATE_FILE`: estado persistido dos alertas.
- `ALERT_DISK_USED_PERCENT`: limite de disco.
- `ALERT_QUEUE_STALLED_MS`: idade máxima de job pendente.
- `ALERT_BACKUP_MAX_AGE_MS`: idade máxima do backup.
- `BACKUP_DIRECTORY`: destino local.
- `BACKUP_REMOTE_DIRECTORY`: destino externo obrigatório em produção.
- `BACKUP_ENCRYPTION_KEY`: chave exclusiva de backup.
- `RETENTION_*_DAYS`: períodos por categoria.
- `EXPORT_DIRECTORY`: diretório de exports temporários.

## Fase 15 — Staging e homologação

As variáveis abaixo pertencem apenas ao ambiente sintético criado por `npm run staging:create`:

- `STAGING_SYNTHETIC_ONLY=1`: marca obrigatória para impedir confusão com produção.
- `STAGING_ENVIRONMENT_ID`: identificador aleatório da criação.
- `REDIS_URL`: conexão separada; o modelo usa o banco lógico 15. A aplicação ainda não usa Redis em produção.
- `DATABASE_CONNECTION_TIMEOUT_MS`: reduz o tempo de falha fechada quando o banco está indisponível.

O arquivo `staging.env` gerado contém segredos aleatórios e fica em `tmp/`, fora do Git. WhatsApp Web, Cloud API e CRM externo permanecem desativados até existirem credenciais exclusivas de homologação.

## Deploy gradual e releases

| Variável | Uso |
|---|---|
| `RELEASE_ID` | Identificador imutável exibido no health e no painel administrativo. |
| `RELEASE_COMMIT` | Commit que originou a release. |
| `RELEASE_BUILT_AT` | Data ISO do build. |
| `DEPLOYMENT_ENVIRONMENT` | Ambiente operacional. |
| `DEPLOYMENT_ROLLOUT_SEED` | Seed estável do rollout percentual. |
| `DEPLOY_HEALTH_URL` | Health consultado após ativação. |
| `DEPLOY_STATE_FILE` | Estado da release ativa e anterior. |
| `FEATURE_*` | Liga ou desliga cada recurso. |
| `FEATURE_*_TENANTS` | Allowlist de tenants para a feature. |
| `FEATURE_*_ROLLOUT_PERCENT` | Percentual determinístico de tenants. |
