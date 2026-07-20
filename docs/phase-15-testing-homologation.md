# Fase 15 — Testes automatizados e homologação

Data: 14/07/2026

## Escopo

A Fase 15 transforma as correções das fases anteriores em testes de regressão reproduzíveis. Todos os cenários locais usam dados sintéticos, segredos aleatórios e integrações externas falsas ou desabilitadas.

## Camadas de teste

### Suíte unitária e de regressão

`npm test` executa em série para evitar interferência entre variáveis de ambiente e stores temporários. A suíte cobre autenticação, autorização, HMAC, CSRF, idempotência, integridade, mídia, merge, status Cloud, fila, banco, observabilidade, backup e LGPD.

### API e concorrência

```bash
npm run test:phase15-api
```

Valida os seis tenants, login, logout, isolamento, leads, tags, CRM, webhooks, conversas e concorrência. Escritas de leads em JSON agora são serializadas por tenant. Duas criações simultâneas com o mesmo telefone resultam em uma criação e conflitos HTTP 409, sem duplicação.

### Navegador

```bash
npm run test:phase15-e2e
```

Executa localmente um teste com Chromium, o HTML real, DOMPurify e o bootstrap de segurança. Valida o contrato visual e regressões XSS sem navegar por rede.

```bash
npm run test:phase15-e2e:live
```

Executa o fluxo navegacional completo em CI ou staging: login, listagem, paginação, busca, detalhes, edição, CRM, conversas, anexos, campanha e XSS.

O Chromium deste ambiente possui a política administrativa `URLBlocklist=["*"]`, que bloqueia inclusive `127.0.0.1`. Por isso o E2E navegacional foi configurado no GitHub Actions e não foi falsamente marcado como executado localmente.

### Carga controlada

```bash
npm run test:phase15-load
```

Cenários sintéticos:

- navegação de 10.000 leads em 20 páginas;
- 100 webhooks assinados em rajada;
- campanha Cloud de 100 contatos em servidor Meta falso;
- validação de PDF de 5 MB.

### Recuperação

```bash
npm run test:phase15-recovery
```

Valida:

- queda forçada do servidor durante campanha;
- retomada sem duplicar destinatários;
- banco indisponível falhando fechado;
- arquivo corrompido bloqueando o boot estrito;
- backup criptografado e restauração em diretório separado.

Redis não é usado pela fila atual. A verificação registra isso explicitamente; o serviço é disponibilizado no staging para uma migração futura, mas não é apresentado como componente ativo.

## Correções encontradas pelos testes

### Busca por e-mail com números

A busca interpretava qualquer consulta que contivesse dígitos como telefone. E-mails com números podiam coincidir com números de WhatsApp. Agora a busca por telefone só é aplicada quando a consulta inteira possui formato de telefone.

### Duplicação concorrente de lead

Duas requisições simultâneas podiam ler o mesmo estado do JSONL e gravar o mesmo WhatsApp. Foi criado um coordenador de escrita por tenant e uma verificação de conflito imediatamente antes da gravação. A API responde HTTP 409 e não duplica o contato.

### Timeout de conexão com banco

Foi introduzido `DATABASE_CONNECTION_TIMEOUT_MS`, permitindo que falhas de conexão sejam encerradas de forma previsível durante boot e recuperação.

## Pipeline CI

`.github/workflows/ci.yml` executa:

1. instalação reproduzível;
2. sintaxe, lint, formato e type checking;
3. testes unitários e regressões;
4. audit de dependências de produção;
5. varredura de segredos;
6. build;
7. API e concorrência;
8. navegador local;
9. staging sintético com PostgreSQL 15 e Redis 7;
10. migrations PostgreSQL;
11. E2E navegacional completo;
12. carga controlada;
13. recuperação.

O workflow foi criado, mas sua execução em um runner GitHub depende de publicar a branch em um repositório conectado.
