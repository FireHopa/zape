# Fase 16: deploy gradual, rollback e entrada em produção

## Princípios

1. Toda release é imutável e possui `release-manifest.json` com checksum por arquivo.
2. O diretório compartilhado de dados nunca fica dentro da release.
3. `/opt/zape/current` aponta para a release ativa e `/opt/zape/previous` preserva a anterior.
4. A troca de release é atômica por symlink.
5. O deploy só avança quando backup e restauração já foram comprovados.
6. Banco não sofre rollback automático. Migrations irreversíveis usam forward fix.
7. O rollout ocorre por tenant e por feature flag.
8. Falha no PM2 ou no monitor pós-deploy aciona rollback do código.
9. HTTPS nunca é removido durante rollback.

## Estrutura recomendada

```text
/opt/zape/releases/<release-id>
/opt/zape/current -> /opt/zape/releases/<release-id>
/opt/zape/previous -> /opt/zape/releases/<release-anterior>
/etc/zape/zape.env
/var/lib/zape/data
/var/lib/zape/deployment-state.json
/var/backups/zape
```

## Criar release

Dry-run:

```bash
npm run release:create -- \
  --release-id=2026.07.14-001 \
  --releases-dir=/opt/zape/releases
```

Aplicar:

```bash
npm run release:create -- \
  --release-id=2026.07.14-001 \
  --releases-dir=/opt/zape/releases \
  --apply \
  --confirm=CREATE_RELEASE
```

A criação exclui `.git`, `node_modules`, dados, backups, logs e arquivos `.env`.

## Backup e restore antes do deploy

```bash
npm run backup:full -- \
  --output-dir=/var/backups/zape \
  --remote-dir=/mnt/zape-offsite
```

Restaure em diretório separado e salve a saída JSON como evidência:

```bash
npm run restore:full -- \
  --input=/var/backups/zape/<arquivo>.enc \
  --output-dir=/var/lib/zape/restore-validation \
  --data-target=/var/lib/zape/restore-validation/data \
  --confirm=RESTORE_FULL_BACKUP \
  > /var/lib/zape/restore-evidence.json
```

## Preflight

```bash
npm run deploy:preflight -- \
  --env=/etc/zape/zape.env \
  --release-dir=/opt/zape/releases/2026.07.14-001 \
  --backup-file=/var/backups/zape/<arquivo>.enc \
  --restore-evidence=/var/lib/zape/restore-evidence.json \
  --migration-evidence=/var/lib/zape/migration-evidence.json
```

Para executar também sintaxe, qualidade, testes, build, scan de segredos e auditoria de permissões:

```bash
npm run deploy:preflight -- \
  ... \
  --execute-checks \
  --confirm=RUN_PREDEPLOY_CHECKS
```

O preflight valida o arquivo de produção como fonte de configuração, mas executa os comandos técnicos em um ambiente de teste isolado, com banco e integrações externas desativados. Isso evita que a suíte de testes acesse serviços reais ou permaneça presa a recursos do runtime de produção.

## Feature flags

Features controladas:

- `FEATURE_AUTH_V2`
- `FEATURE_DATABASE_PERSISTENCE`
- `FEATURE_CLOUD_QUEUE`
- `FEATURE_SECURE_MEDIA`
- `FEATURE_CLOUD_API_V2`
- `FEATURE_LEAD_PAGINATION`
- `FEATURE_FRONTEND_V2`

`FEATURE_AUTH_V2` funciona como controle fail-closed. Em produção ela não pode ser desativada, pois o sistema não restaura a autenticação legada insegura.

Cada uma aceita:

```env
FEATURE_FRONTEND_V2=1
FEATURE_FRONTEND_V2_TENANTS=admin,panel
FEATURE_FRONTEND_V2_ROLLOUT_PERCENT=50
```

O percentual é determinístico por `DEPLOYMENT_ROLLOUT_SEED`, feature e tenant. Alterar a seed redistribui o grupo e não deve ser feito durante uma janela em andamento.

O endpoint abaixo mostra o estado efetivo das flags e a release servida:

```text
GET /api/admin/deployment
```

Somente `super_admin` possui acesso.

## Plano de ondas

```bash
npm run deploy:rollout-plan -- \
  --release-id=2026.07.14-001 \
  --tenants=admin,panel,regina,portugal,felipe,ana \
  --observation-minutes=30 \
  --output=/var/lib/zape/rollout-plan.json
```

Critérios mínimos para avançar:

- `/health` estável e com o `RELEASE_ID` esperado;
- login e logout do tenant funcionando;
- sem aumento de 5xx;
- fila não parada;
- WhatsApp e Cloud conforme o escopo da onda;
- sem acesso cruzado;
- backup e alertas operacionais ativos.

## Ativação

Dry-run:

```bash
RELEASE_DIR=/opt/zape/releases/2026.07.14-001 \
RELEASE_ID=2026.07.14-001 \
bash deploy/activate-release.sh
```

Aplicar:

```bash
sudo RELEASE_DIR=/opt/zape/releases/2026.07.14-001 \
  RELEASE_ID=2026.07.14-001 \
  DEPLOY_HEALTH_URL=https://bobia.com.br/health \
  bash deploy/activate-release.sh --apply
```

O script:

1. troca o symlink;
2. reinicia o PM2 com `--update-env`;
3. consulta o health repetidamente;
4. confere a release realmente servida;
5. volta para a release anterior em caso de falha.

## Monitoramento pós-deploy

```bash
npm run deploy:monitor -- \
  --health-url=https://bobia.com.br/health \
  --release-id=2026.07.14-001 \
  --iterations=12 \
  --interval-ms=5000
```

Acompanhar adicionalmente:

- login e logout;
- erros 5xx;
- fila pendente e parada;
- WhatsApp Web;
- Cloud API;
- campanhas;
- latência;
- disco e memória;
- banco e Redis;
- assinatura dos webhooks;
- tentativas de acesso cruzado.

## Rollback de código

```bash
sudo bash deploy/rollback-release.sh --apply
```

O rollback:

- reativa a release anterior;
- reinicia PM2;
- não toca nos dados;
- não toca no banco;
- não remove HTTPS.

## Banco e migrations

Rollback automático de banco é proibido. Antes de qualquer migration:

- classificar como reversível ou irreversível;
- gerar backup;
- validar restore;
- documentar dados criados após o deploy;
- preparar forward fix;
- separar migration de expansão da migration de contração.

Estratégia recomendada:

1. expandir schema de forma compatível;
2. publicar código que entenda schema antigo e novo;
3. migrar dados;
4. validar;
5. somente depois remover colunas ou contratos antigos.

## Critérios para declarar produção

- release imutável e identificável;
- preflight aprovado;
- CI aprovado;
- staging aprovado;
- backup e restore aprovados;
- rollback de código testado;
- métricas e alertas ativos;
- canário validado;
- todos os tenants validados;
- nenhuma perda de acesso ou dados.
