# Fase 11 — Persistência relacional

## Objetivo

Preparar o Zape para substituir arquivos JSON/JSONL por PostgreSQL com migrations versionadas, constraints, transações, importação idempotente, backup, restauração e corte controlado.

## Banco recomendado

Produção deve usar PostgreSQL 15 ou superior. SQLite existe somente como mecanismo local de teste e homologação sintética; o boot de produção rejeita `DATABASE_URL=sqlite:`.

## Modos de transição

- `PERSISTENCE_MODE=json`: comportamento compatível anterior.
- `PERSISTENCE_MODE=shadow`: JSON continua primário e gravações de leads são comparadas com o banco. Exige responsável e data final.
- `PERSISTENCE_MODE=database`: PostgreSQL passa a ser fonte principal do domínio de leads e o JSON deixa de receber novas gravações nesse domínio.

O modo shadow expira automaticamente. Isso impede dual-write indefinido.

## Escopo do corte funcional nesta fase

O esquema e o importador cobrem tenants, usuários, sessões, leads, origens, histórico, tags, funis, conversas, mensagens, status, mídias, webhooks, Cloud API, campanhas, disparos, jobs e auditoria.

O servidor foi conectado ao banco como fonte principal para o domínio de leads, incluindo criação, leitura, edição, merge, exclusão, versão otimista e persistência após restart. Os demais domínios já possuem tabelas e importação, mas continuam usando os stores JSON de compatibilidade até seus repositórios serem ligados às rotas. Portanto, o corte total de todos os domínios não deve ser declarado em produção nesta fase.

## Migrations

```bash
PERSISTENCE_MODE=shadow \
DATABASE_URL='postgresql://...' \
npm run db:migrate
```

As migrations possuem checksum. Alterar uma migration já aplicada bloqueia a execução.

## Dry-run da importação

```bash
npm run db:import -- \
  --data-dir=/var/lib/zape/data \
  --report=/var/lib/zape/reports/database-import-plan.json
```

O dry-run não conecta ao banco e não altera dados.

## Aplicação controlada

```bash
PERSISTENCE_MODE=shadow \
PERSISTENCE_SHADOW_UNTIL='2026-08-15T23:59:59-03:00' \
PERSISTENCE_SHADOW_OWNER='responsavel-tecnico' \
DATABASE_URL='postgresql://...' \
npm run db:import -- \
  --data-dir=/var/lib/zape/data \
  --report=/var/lib/zape/reports/database-import-result.json \
  --apply \
  --confirm=IMPORT_JSON_TO_DATABASE
```

A origem é identificada por checksum. Executar novamente a mesma importação retorna o lote anterior sem duplicar registros.

## Constraints principais

- telefone normalizado único por tenant;
- Meta message ID único por conexão;
- idempotency key única por escopo;
- chaves estrangeiras entre leads, tags, funis, conversas, mensagens, campanhas e jobs;
- `tenant_id` em todas as tabelas multitenant;
- segredos em colunas destinadas a conteúdo criptografado.

## Backup e restauração

Backup lógico criptografado:

```bash
PERSISTENCE_MODE=database \
DATABASE_URL='postgresql://...' \
CONFIG_ENCRYPTION_KEY='...' \
npm run db:backup -- --output=/var/backups/zape/database-backup.json
```

Restauração:

```bash
npm run db:restore -- \
  --input=/var/backups/zape/database-backup.json \
  --confirm=RESTORE_DATABASE_BACKUP
```

A restauração valida checksum antes de alterar o banco.

## Cutover

1. Fazer backup dos JSON e do banco.
2. Executar migrations.
3. Executar dry-run e revisar quarentena.
4. Importar em staging.
5. Comparar contagens e amostras por tenant.
6. Ativar shadow com prazo curto.
7. Verificar divergências.
8. Ativar `PERSISTENCE_MODE=database` apenas para o escopo homologado.
9. Manter os JSON somente como backup imutável durante a janela de rollback.
10. Não manter dual-write indefinidamente.

## Limitação de homologação

O ambiente desta execução não possuía um servidor PostgreSQL instalado. A migration PostgreSQL foi validada estruturalmente e o comportamento relacional foi executado em SQLite local com o mesmo modelo lógico. Antes de produção, é obrigatório executar migrations, importação, concorrência e restore em PostgreSQL 15+ de staging.
