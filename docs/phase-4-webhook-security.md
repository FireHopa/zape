# Fase 4: segurança dos webhooks e endpoints públicos

Data: 13/07/2026

## Escopo

Foram protegidos:

- `POST /api/leads`
- `POST /webhooks/activecampaign`
- `POST /webhooks/:token`
- `GET /webhooks/wa-cloud`
- `POST /webhooks/wa-cloud`
- `/debug/active`

Nenhuma alteração de banco, mídia, frontend, CORS, CSP ou CSRF foi incluída nesta fase.

## Meta: validação de assinatura

O backend preserva o corpo como bytes apenas nas cadeias que exigem assinatura: Meta e webhooks customizados. Esse raw body não é armazenado globalmente. Na rota da Meta, o sistema calcula HMAC SHA-256 com o App Secret e compara com `X-Hub-Signature-256` usando `timingSafeEqual`.

Ordem de validação:

1. Content-Type JSON.
2. Rate limit.
3. App Secret disponível.
4. Assinatura presente e válida.
5. JSON válido e schema mínimo da Meta.
6. Idempotência.
7. Processamento de status e mensagens.

Evento forjado é rejeitado com HTTP 401 antes de qualquer escrita.

## Webhooks customizados

A URL continua usando um token aleatório de 32 bytes, armazenado de forma criptografada e localizado por hash. Além do token, produção exige HMAC com proteção contra replay.

Cabeçalhos obrigatórios:

```text
X-Zape-Timestamp: 1783950000
X-Zape-Event-Id: evento_123
X-Zape-Signature: sha256=<hex>
```

Conteúdo assinado:

```text
<timestamp>.<eventId>.<raw body>
```

Exemplo Node.js:

```js
const crypto = require('crypto');

const timestamp = String(Math.floor(Date.now() / 1000));
const eventId = 'evento_123';
const body = JSON.stringify({ nome: 'Contato', whatsapp: '5511999999999' });
const signed = `${timestamp}.${eventId}.${body}`;
const signature = crypto.createHmac('sha256', WEBHOOK_TOKEN).update(signed).digest('hex');

await fetch(WEBHOOK_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Zape-Timestamp': timestamp,
    'X-Zape-Event-Id': eventId,
    'X-Zape-Signature': `sha256=${signature}`,
  },
  body,
});
```

O tenant é sempre resolvido pelo webhook armazenado. Campos como `tenant`, `tenantId` ou equivalentes enviados no payload não alteram o tenant de destino.

Para preservar integrações existentes, a rota aceita `application/json` e `application/x-www-form-urlencoded`. Em ambos os formatos, a assinatura é calculada sobre os bytes exatos recebidos, antes de qualquer uso dos campos pelo fluxo de leads.

## ActiveCampaign

O webhook fixo fica desabilitado por padrão em produção e só opera quando:

- `ACTIVECAMPAIGN_WEBHOOK_ENABLED=1`
- `ACTIVECAMPAIGN_WEBHOOK_TOKEN` possui pelo menos 32 caracteres
- o token correto é enviado por header ou Bearer

Cabeçalhos aceitos:

```text
X-Zape-Webhook-Token: <token>
```

ou:

```text
Authorization: Bearer <token>
```

Token em query string permanece bloqueado por padrão. A compatibilidade só deve ser habilitada conscientemente com `ALLOW_WEBHOOK_TOKEN_IN_QUERY=1`, pois proxies podem registrar a URL.

A idempotência usa `X-Zape-Event-Id`, `X-Idempotency-Key` ou, na ausência, hash do payload.

## Formulário público legado

Em produção, `/api/leads` retorna 404 até que `PUBLIC_LEAD_FORM_ENABLED=1` seja configurado. Quando ativo, exige token forte. O payload usa allowlist de campos e rejeita campos desconhecidos.

## Idempotência

`src/webhookEventStore.js` mantém um arquivo JSON atômico com:

- hash da chave composta por integração, tenant e evento
- hash do tenant
- estado `pending` ou `completed`
- status HTTP e resposta técnica sem PII
- expiração

O arquivo não contém event ID bruto, token de webhook, telefone, e-mail ou corpo recebido.

Comportamento:

- primeira requisição reivindica o evento
- repetição durante processamento recebe HTTP 202
- repetição após conclusão recebe o mesmo status e resultado técnico
- reutilização da mesma chave com payload diferente recebe HTTP 409
- eventos expirados são removidos
- evento pendente abandonado pode ser retomado após timeout

A implementação pressupõe uma instância PM2. Lock distribuído e banco pertencem às fases posteriores.

## Rate limiting

O limitador atual é local ao processo e usa chave com hash. A identidade usa o endereço do socket por padrão, sem confiar em `X-Forwarded-For`.

Escopos:

- formulário: IP
- ActiveCampaign: IP e integração
- customizado: IP, tenant e webhook
- Meta: IP

Ao exceder o limite, a resposta é HTTP 429 com `Retry-After`.

## Limites de payload

- formulário público: 250 KB
- webhooks comuns: 500 KB
- Meta: 1 MB

Payload acima do limite recebe HTTP 413. Content-Type incompatível recebe HTTP 415. JSON malformado recebe HTTP 400.

## `/debug/active`

A rota não é registrada em produção. Fora de produção, ela exige simultaneamente:

- `DEBUG=1`
- `ENABLE_DEBUG_ACTIVE=1`
- sessão válida do tenant `admin`
- papel `super_admin`

Mesmo habilitada, registra somente Content-Type, Content-Length e nomes limitados dos campos.

## Compatibilidade e implantação

Mudanças que exigem ajuste de integrações:

- Webhooks customizados precisam passar a assinar requisições.
- ActiveCampaign precisa enviar token por header/Bearer, ou usar query somente com compatibilidade explícita.
- O formulário legado precisa ser habilitado e receber token.
- A Meta precisa ter App Secret disponível em runtime.

Faça rollout em staging e atualize os emissores antes de publicar em produção.
