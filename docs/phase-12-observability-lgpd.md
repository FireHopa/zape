# Fase 12 — Observabilidade, auditoria, backups e LGPD

## Escopo

Esta fase adiciona logs estruturados, correlação de operações, auditoria resistente a adulteração, métricas, alertas, retenção, backup criptografado e operações de exportação/exclusão por contato. Não substitui a definição jurídica da base legal pelo controlador e não executa exclusões reais sem confirmação explícita.

## Logs estruturados

- JSONL em `STRUCTURED_LOG_FILE`.
- Níveis: `debug`, `info`, `warn`, `error` e `security`.
- `correlationId` por requisição e `operationId` por workflow.
- Mascaramento de telefone, e-mail, WhatsApp JID, cookie, Authorization, token e segredos.
- Rotação por tamanho, mantendo quantidade configurável de arquivos.
- O bridge de console preserva compatibilidade com logs legados, mas envia a saída também ao logger sanitizado.

## Auditoria

O arquivo `SECURITY_AUDIT_FILE` usa JSONL encadeado por SHA-256. Cada entrada contém o hash da entrada anterior. O comando abaixo valida a cadeia:

```bash
npm run audit:verify
```

São auditados login, logout, falha de login, negação administrativa, exportação, exclusão, edição, merge, alteração de configuração, campanhas e consultas administrativas adicionadas nas fases anteriores.

## Métricas e alertas

Endpoints exclusivos do `super_admin`:

- `GET /api/admin/monitoring`
- `GET /api/admin/metrics`

Alertas implementados:

- uso de disco acima do limite
- fila parada
- backup ausente ou antigo
- banco indisponível
- WhatsApp desconectado
- Cloud API inválida
- taxa de erro HTTP 5xx acima do limite

Os alertas possuem cooldown, estado persistente e webhook opcional.

## Retenção

O comando é dry-run por padrão:

```bash
npm run retention:run
```

Aplicação exige confirmação explícita:

```bash
npm run retention:run -- --apply --confirm=APPLY_RETENTION_POLICY
```

Arquivos antigos são movidos para quarentena. O arquivo ativo de auditoria não é truncado por linha, pois isso quebraria a cadeia de integridade. Arquivos de auditoria rotacionados podem ser tratados como unidades após backup.

## LGPD

Rotas por tenant:

- `GET /api/<tenant>/privacy/contact?phone=<telefone>`
- `POST /api/<tenant>/privacy/contact/delete`

A exclusão é dry-run quando `apply` não é `true`. Para aplicar, o corpo deve conter:

```json
{
  "phone": "...",
  "apply": true,
  "confirmation": "DELETE_CONTACT_DATA"
}
```

No modo JSON, os arquivos afetados são copiados para quarentena antes da alteração. No modo banco, a operação usa transação. A exclusão preserva apenas dados cuja retenção legal tenha sido definida e implementada pelo controlador; essa decisão não é inferida automaticamente pelo sistema.

## Backup e restauração

Backup completo:

```bash
npm run backup:full
```

Em produção, `BACKUP_REMOTE_DIRECTORY` é obrigatório. O arquivo é compactado, recebe manifesto de checksums, é criptografado com AES-256-GCM e copiado para o destino externo. O checksum da cópia externa deve ser igual ao local.

Restauração em ambiente separado:

```bash
npm run restore:full -- \
  --input=/caminho/backup.tar.gz.enc \
  --output-dir=/var/lib/zape/restore-test \
  --data-target=/var/lib/zape/restore-test/data \
  --confirm=RESTORE_FULL_BACKUP
```

Use `--restore-database` somente com banco de destino separado e vazio.

## Operação recomendada

- Monitoramento: a cada 5 minutos.
- Backup: diário.
- Teste de restauração: mensal.
- Retenção: diária ou semanal, conforme volume.
- Verificação da cadeia de auditoria: diária.
- Quarentenas: storage criptografado e acesso restrito.
