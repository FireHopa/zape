# Rotação de segredos do Zape

## Objetivo

Retirar credenciais do código, de arquivos JSON legíveis, logs, backups compartilháveis e pacotes ZIP. Cada ambiente deve possuir segredos exclusivos.

## Segredos que devem ser rotacionados externamente

1. `SESSION_SECRET`
2. Senhas dos tenants: `ADMIN_PASS`, `PANEL_PASS`, `REGINA_PASS`, `PORTUGAL_PASS`, `FELIPE_PASS` e `ANA_PASS`
3. `WA_EMBEDDED_APP_SECRET`
4. `WA_CLOUD_TOKEN`
5. `WA_CLOUD_WEBHOOK_VERIFY_TOKEN`
6. `CRM_INTEGRATION_KEY`
7. Tokens dos webhooks customizados
8. `CONFIG_ENCRYPTION_KEY`

## Ordem recomendada

1. Criar backup criptografado e validar o restore.
2. Gerar `CONFIG_ENCRYPTION_KEY` exclusiva para produção.
3. Executar a migração em dry-run.
4. Executar a migração com `--apply` em cópia de staging.
5. Validar leitura dos segredos criptografados.
6. Rotacionar credenciais nos serviços externos.
7. Atualizar o ambiente do servidor sem registrar valores no terminal compartilhado.
8. Reiniciar o processo de forma controlada.
9. Invalidar as credenciais antigas.
10. Confirmar que a varredura de segredos está limpa.

## Geração segura

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Nunca cole a chave em issue, commit, documentação, conversa, screenshot ou log.

## Migração dos JSON legados

Dry-run, sem alterar arquivos:

```bash
CONFIG_ENCRYPTION_KEY='valor-do-ambiente' npm run security:migrate -- --data-dir /copia/data
```

Aplicação com backup automático:

```bash
CONFIG_ENCRYPTION_KEY='valor-do-ambiente' npm run security:migrate -- --data-dir /copia/data --apply
```

Rollback:

```bash
npm run security:migrate -- --data-dir /copia/data --rollback /caminho/do/backup
```

O relatório informa somente tipos de segredo, quantidades, hashes de arquivo e nomes de arquivo. Valores nunca são exibidos.

## Meta

### App Secret

1. Criar novo App Secret no painel da Meta.
2. Atualizar `WA_EMBEDDED_APP_SECRET` ou salvar pelo painel com cofre configurado.
3. Validar Embedded Signup e webhook.
4. Invalidar o segredo antigo.

### Access token

1. Gerar token novo para a conta correta.
2. Validar WABA ID e Phone Number ID.
3. Atualizar `WA_CLOUD_TOKEN` ou refazer Embedded Signup.
4. Confirmar envio e consulta de template em staging.
5. Revogar o token antigo.

### Verify token

1. Gerar valor aleatório novo.
2. Atualizar `WA_CLOUD_WEBHOOK_VERIFY_TOKEN` no servidor.
3. Atualizar a assinatura do webhook na Meta.
4. Confirmar a verificação GET.

## Webhooks customizados

Os tokens antigos devem ser considerados comprometidos por terem sido incluídos no pacote original. Após a migração do storage, gere novos tokens por webhook, atualize os sistemas emissores e desative os anteriores em janela controlada.

## Sessão e tenants

1. Trocar `SESSION_SECRET` invalida cookies atuais.
2. Planejar comunicação e janela de logout.
3. Trocar cada senha de tenant por valor único.
4. Não reutilizar senha como segredo de sessão.

## CRM externo

1. Gerar nova chave no CRM.
2. Atualizar `CRM_INTEGRATION_KEY`.
3. Validar catálogo e envio sintético.
4. Revogar a chave antiga.

## Chave de criptografia

A rotação de `CONFIG_ENCRYPTION_KEY` exige descriptografar com a chave anterior e recriptografar com a nova em cópia controlada. Não troque diretamente no ambiente sem migração, pois os segredos persistidos ficarão ilegíveis.
