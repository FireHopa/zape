# Schemas e versões dos arquivos persistidos

A aplicação ainda usa arquivos JSON e JSONL. Para não alterar o formato de arquivos que são mapas por telefone, cada tenant recebe um sidecar `.zape-data-manifest.json` após uma migração aplicada.

| Arquivo | Versão | Regra principal |
|---|---:|---|
| `leads.jsonl` | 1 | Um objeto JSON por linha. `schemaVersion=1` em cada registro migrado. |
| `conversations.json` | 1 | Objeto cujas chaves são telefones normalizados e os valores são listas de mensagens. |
| `message_status.json` | 1 | Objeto cujas chaves são telefones normalizados. |
| `crm.json` | 1 | Estado com `pipelines`, `stages` e `leadIds`. |
| `tags.json` | 1 | Lista de tags. |
| `lead_tags.json` | 1 | Mapa `leadId -> tagIds`. |
| `lead_changes.jsonl` | 1 | Histórico de edição e merge com ator em hash, data e valores anteriores/novos. |
| `funnel_stages.json` | 1 | Lista de etapas. |
| `funnel_lead_stage.json` | 1 | Mapa `leadId -> stageId`. |
| `wa_cloud_saved_sheets.json` | 1 | Lista de planilhas salvas. |
| `wa_cloud_dispatches.json` | 2 | Campanhas, disparos tenant-aware, histórico de estados, índice por `connectionId + messageId` e eventos recebidos não correlacionados. |
| `wa_cloud_jobs.json` | 1 | Fila persistente, progresso, cursor, tentativas, erros redigidos e dead-letter de workflows fatais. |

O manifesto registra versão, SHA-256 e tamanho. O boot pode validar esses valores com `DATA_INTEGRITY_VALIDATE_ON_BOOT=1`. Para bloquear o boot em inconsistência, usar `DATA_INTEGRITY_STRICT_BOOT=1` depois da primeira migração controlada.


## `wa_cloud_dispatches.json` versão 2

Estrutura principal:

```json
{
  "version": 2,
  "campaigns": [],
  "events": [],
  "inboundEvents": [],
  "messageIndex": {}
}
```

Cada evento de disparo inclui:

- `tenantId`
- `connectionId`
- `phoneNumberId`
- `wabaId`
- `campaignId`
- `dispatchId`
- `recipientId`
- `messageId`
- `conversationId`
- `status`
- `statusHistory`

O índice usa a chave lógica `connectionId:MetaMessageId`. Eventos antigos são normalizados em memória e regravados no formato 2 quando houver uma alteração legítima. Arquivo corrompido falha fechado.


## `wa_cloud_jobs.json` versão 1

Campos principais por job:

- `id`, `tenantId`, `type`, `state`
- `idempotencyKeyHash`, `payloadHash`
- `cursor`, `attempts`, `itemAttempts`, `nextRunAt`
- `progress.total`, `processed`, `sent`, `delivered`, `read`, `responded`, `failed`, `pending`
- `createdAt`, `startedAt`, `updatedAt`, `completedAt`

O arquivo é escrito atomicamente com permissão `0600`.

## Banco relacional — Fase 11

A migration principal está em `db/migrations/postgres/001_initial_schema.sql` e cria 25 tabelas de domínio, além de `schema_migrations`, `import_batches` e `import_quarantine`.

Principais relações:

- `tenants` → todos os dados multitenant;
- `leads` → `lead_sources`, `lead_changes`, `lead_tags`, `funnel_leads`;
- `conversations` → `messages` → `message_status_history` e `media`;
- `cloud_connections` → `cloud_templates`, `cloud_campaigns`, `cloud_dispatches`;
- `jobs` mantém idempotência, progresso, tentativas, lock e erro final;
- `import_batches` impede importação duplicada da mesma origem.

PostgreSQL utiliza `jsonb` para preservar campos legados durante a transição sem perder dados desconhecidos.

## Fase 12 — Novos artefatos operacionais

### Log estruturado JSONL

Campos principais: `timestamp`, `level`, `message`, `event`, `correlationId`, `operationId`, `tenantId` e metadados sanitizados.

### Auditoria JSONL

Campos principais: `schemaVersion`, `timestamp`, `action`, `target`, `result`, `actorHash`, `tenantId`, `correlationId`, `operationId`, `previousHash` e `entryHash`.

### Estado de alertas

JSON versionado com alertas ativos, última emissão, resolução e cooldown.

### Backup criptografado

Envelope binário `ZAPEBACKUP1`, IV GCM, payload tar.gz criptografado e tag de autenticação. O payload contém `backup-manifest.json` com SHA-256 e tamanho de cada arquivo.
