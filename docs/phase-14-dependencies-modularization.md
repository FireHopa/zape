# Fase 14 — Dependências, modularização e código legado

## Escopo executado

A fase foi realizada sem reescrever o sistema. As mudanças foram agrupadas em dependências compatíveis, rotas tenant-aware, extração gradual do frontend, remoção comprovada de legado e qualidade progressiva.

## Dependências

### Produção

| Dependência | Antes | Depois | Validação |
|---|---:|---:|---|
| Express | 4.22.1 instalado, faixa `^4.19.2` | 4.22.2 fixo | 137 testes, smoke dos seis tenants |
| whatsapp-web.js | 1.34.6 instalado, faixa `^1.24.1` | 1.34.7 fixo | exports `Client`, `LocalAuth` e `MessageMedia` carregados |
| path-to-regexp | 0.1.12 transitivo | override 0.1.13 | rotas e políticas auditadas |

O `npm audit --omit=dev` caiu de 10 vulnerabilidades para zero. Não foi utilizado `npm audit fix --force`. As cadeias de desenvolvimento também foram corrigidas com overrides restritos para `minimatch@10.2.5`, `brace-expansion@5.0.7` e `picomatch@2.3.2`. O audit completo e de produção offline retornaram zero; a última repetição do endpoint online ficou indisponível por HTTP 502 e foi registrada nas evidências.

### Desenvolvimento

| Ferramenta | Versão |
|---|---:|
| Vite | 8.1.4 |
| ESLint | 9.39.2 |
| Prettier | 3.9.5 |
| TypeScript | 5.8.3 |
| Nodemon | 3.1.14 |
| @types/express | 4.17.25 |
| @types/node | 22.20.1 |

A atualização do Vite revelou um fragmento inválido em `public/app.css` que o minificador antigo apenas reportava como warning. O fragmento foi convertido para CSS válido e o build passou com Vite 8.

## Modularização do backend

O bloco repetido de aproximadamente 950 linhas foi substituído por um registrador comum.

```text
src/routes/tenant/
  registerTenantPanelRoutes.js
  uiRoutes.js
  leadRoutes.js
  crmRoutes.js
  whatsappWebRoutes.js
  contentRoutes.js
  webhookManagementRoutes.js
```

Outros domínios extraídos:

```text
src/routes/healthRoutes.js
src/routes/businessRoutes.js
src/routes/adminMonitoringRoutes.js
```

Cada tenant recebe 25 rotas comuns a partir da configuração autenticada do servidor. O tenant não é obtido de query string ou body.

Resultado estrutural:

- `server.js` antes: 4.668 linhas.
- `server.js` depois: 3.756 linhas.
- Redução: 912 linhas.
- Rotas tenant-aware auditadas: 210.
- Rotas sem política: 0.

## Modularização gradual do frontend

Foram extraídos:

- `public/modules/app-config.js`
- `public/modules/api-client.js`

A configuração de tenant, prefixos e idioma Cloud não fica mais duplicada dentro do arquivo principal. O cliente de API centraliza `credentials: same-origin`, `cache: no-store`, Accept JSON e tratamento comum de respostas.

`public/app.js` ainda contém os módulos de leads, CRM, conversas e Cloud. A divisão futura deve ser incremental e acompanhada de testes, sem reescrita total.

## Código legado removido

Removidos após auditoria de referências e regressão:

- `src/leadsStore.js`
- `src/leadTagsStore.js`
- `src/tagsStore.js`
- `src/messageStatusStore.js`
- `src/whatsapp.js`
- `public/admin.html`
- `public/panel.html`
- `public/regina.html`
- `public/index.html`

O Vite passou a gerar apenas a interface unificada. As URLs antigas continuam redirecionadas pelo Express.

## Qualidade progressiva

Comandos adicionados:

```bash
npm run lint
npm run format:check
npm run typecheck
npm run quality
npm run audit:dependencies
npm run test:phase14-smoke
```

O type checking ainda é progressivo e cobre os módulos extraídos em `src/routes/**/*.js`. Ampliar para `server.js` e `public/app.js` de uma vez produziria uma mudança extensa e arriscada.

## Rollback

Os commits da fase podem ser revertidos separadamente. Após a reversão das dependências, execute `npm ci` com `PUPPETEER_SKIP_DOWNLOAD=1` e garanta um ffmpeg do sistema por `FFMPEG_PATH` ou pacote operacional.

A remoção dos HTMLs legados não altera as URLs públicas porque o Express continua redirecionando `/admin.html`, `/panel.html`, `/regina.html` e `/index.html` para as rotas autenticadas.
