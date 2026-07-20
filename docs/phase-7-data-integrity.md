# Fase 7 — Integridade dos dados e migrações controladas

## Princípios

- Auditorias são somente leitura.
- Relatórios públicos usam contagens e hashes, nunca PII.
- A migração é dry-run por padrão.
- A aplicação exige backup, checksum e confirmação explícita.
- Registros incertos são enviados à quarentena, não apagados.
- Mídias são movidas para quarentena, nunca removidas definitivamente.
- O rollback recusa restaurar quando um arquivo foi alterado após a migração.

## Auditoria completa

```bash
npm run data:audit -- \
  --data-dir=/var/lib/zape/data \
  --output=/var/lib/zape/reports/data-integrity-audit.json
```

Auditorias separadas:

```bash
npm run data:audit:leads -- --data-dir=/var/lib/zape/data
npm run data:audit:statuses -- --data-dir=/var/lib/zape/data
npm run data:audit:media -- --data-dir=/var/lib/zape/data
npm run data:audit:conversations -- --data-dir=/var/lib/zape/data
npm run data:audit:crm -- --data-dir=/var/lib/zape/data
npm run data:audit:tags -- --data-dir=/var/lib/zape/data
```

## Dry-run da migração

```bash
npm run data:migrate -- \
  --data-dir=/var/lib/zape/data \
  --output=/var/lib/zape/reports/data-integrity-plan.json \
  --retention-days=30
```

O plano não contém valores de leads, telefones, e-mails ou mensagens. O plano interno em memória contém os dados necessários, mas eles não são serializados no relatório público.

## Aplicação em staging

```bash
npm run data:migrate -- \
  --data-dir=/var/lib/zape-staging/data \
  --output=/var/lib/zape-staging/reports/data-integrity-plan.json \
  --backup-dir=/var/backups/zape/data-integrity/<janela> \
  --retention-days=30 \
  --apply \
  --confirm=APPLY_DATA_INTEGRITY
```

Para mover mídias duplicadas e órfãs antigas para quarentena:

```bash
# Adicionar ao comando anterior:
--confirm-media=QUARANTINE_ORPHAN_MEDIA
```

## Rollback

```bash
npm run data:migrate -- \
  --rollback=/var/backups/zape/data-integrity/<janela>/rollback-manifest.json \
  --confirm=ROLLBACK_DATA_INTEGRITY
```

## Estratégia de deduplicação

A chave de unicidade é `tenantId + telefone normalizado`.

A escolha do registro principal é determinística:

1. ID já referenciado no CRM, tags ou funil.
2. Registro com maior quantidade de campos úteis.
3. Registro mais antigo.
4. ID em ordem lexical.
5. Número da linha no JSONL.

O merge preserva:

- IDs consolidados em `mergedLeadIds`.
- origens em `mergedOrigins`.
- metadados de origem em `mergedSourceMeta`.
- valores conflitantes em `mergedFieldAlternates`.
- histórico da operação em `mergeHistory`.
- tags em união sem duplicidade.

## Arquivos relacionados

- `src/dataIntegrity.js`
- `scripts/audit-*.js`
- `scripts/migrate-data-integrity.js`
- `scripts/verify-data-integrity.js`
- `schemas/data-files.schema.json`
