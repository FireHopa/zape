# Fase 10 — Filas, idempotência e campanhas assíncronas

## Objetivo

Retirar o envio em massa do ciclo da requisição HTTP e impedir duplicações causadas por timeout, refresh, retry do proxy ou reinício do processo.

## Fluxo atual

1. `POST /api/wa-cloud/send-template-batch` valida conexão, template, contatos e limite.
2. A chave `Idempotency-Key` é resolvida por tenant e tipo de job. Na ausência do header, o servidor calcula uma chave determinística a partir do payload normalizado.
3. A campanha e os eventos `queued` são persistidos.
4. A resposta retorna HTTP 202 com `job.id`.
5. O worker lê `data/wa_cloud_jobs.json`, processa um destinatário por vez e salva o cursor depois de cada resultado.
6. Falhas transitórias usam backoff exponencial. Falhas permanentes avançam o cursor e entram no resumo da campanha.
7. Jobs `queued` continuam após reinício. Se o processo caiu no meio de uma chamada à Meta, o job é pausado com `DELIVERY_UNCERTAIN_AFTER_RESTART` para impedir reenvio automático possivelmente duplicado. A retomada exige ação explícita.

## Estados

- `draft`
- `queued`
- `running`
- `paused`
- `completed`
- `completed_with_errors`
- `failed`
- `canceled`

## Endpoints

- `POST /api/wa-cloud/send-template-batch`
- `GET /api/wa-cloud/jobs`
- `GET /api/wa-cloud/jobs-health`
- `GET /api/wa-cloud/jobs/:jobId`
- `POST /api/wa-cloud/jobs/:jobId/pause`
- `POST /api/wa-cloud/jobs/:jobId/resume`
- `POST /api/wa-cloud/jobs/:jobId/cancel`

Todos usam o tenant da sessão autenticada. Um tenant não consulta ou controla jobs de outro.

## Retry

O erro normalizado da Meta define se a falha é transitória. O intervalo cresce exponencialmente até `WA_CLOUD_QUEUE_RETRY_MAX_MS`. Ao esgotar tentativas, o destinatário é marcado como falha permanente e o worker continua a campanha.

## Idempotência

A fila persiste apenas o hash da chave. A mesma chave e o mesmo payload retornam o job existente. A mesma chave com payload diferente retorna HTTP 409.

## Dead-letter

Falhas fatais do workflow são registradas em `deadLetters`, sem copiar a lista de contatos. Falhas permanentes por destinatário permanecem no histórico do job e no evento Cloud correspondente.

## Limitação atual

A implementação usa arquivo JSON atômico como fila equivalente, adequada à arquitetura atual de uma única instância. Redis + BullMQ continua recomendado após a infraestrutura de Redis e o banco relacional estarem disponíveis. Não ativar PM2 cluster nesta etapa.
