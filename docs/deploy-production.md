# Deploy de produção do Zape

Este procedimento não executa migrações de dados. Faça backup completo e valide a restauração antes de começar.

## 1. Pré-requisitos

- DNS de `bobia.com.br` e `www.bobia.com.br` apontando para o servidor.
- Ubuntu/Debian com Nginx, Certbot, Node.js compatível e PM2.
- acesso root apenas para preparar sistema, Nginx e firewall;
- código em `/opt/zape/current`;
- dados fora da release em `/var/lib/zape/data`;
- uma cópia do Nginx e do `.env` atuais para rollback.

## 2. Configuração mínima de produção

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
TRUST_PROXY_HOPS=1
PUBLIC_BASE_URL=https://bobia.com.br
APP_ALLOWED_ORIGINS=https://bobia.com.br,https://www.bobia.com.br
AUTH_TRUST_PROXY_HEADERS=1
PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS=1
INFRA_ALLOW_ROOT_PROCESS=0
INFRA_ALLOW_HTTP_FOR_TESTS=0
ZAPE_DATA_DIR=/var/lib/zape/data
SESSION_STORE_FILE=/var/lib/zape/auth_sessions.json
WEBHOOK_IDEMPOTENCY_FILE=/var/lib/zape/webhook_idempotency.json
SECURITY_AUDIT_FILE=/var/log/zape/security_audit.jsonl
```

Mantenha `WEBJS_NO_SANDBOX=0` quando o Chromium funcionar com sandbox no usuário não-root.

## 3. Validar antes de alterar o servidor

```bash
npm ci
npm test
npm run check:syntax
npm run build:web
npm run security:scan
npm run audit:permissions
npm run infra:validate
npm run test:phase13-nginx
```

Revise o plano sem executar:

```bash
bash deploy/install-infrastructure.sh
SSH_ALLOWED_CIDR=SEU_IP/32 bash deploy/configure-firewall.sh
LETSENCRYPT_EMAIL=seu-email@dominio.com bash deploy/issue-certificate.sh
```

## 4. Primeira instalação do Nginx

Sem certificado disponível, o instalador seleciona a configuração bootstrap:

```bash
sudo bash deploy/install-infrastructure.sh --apply
```

O bootstrap responde ao desafio ACME e retorna 503 para o restante. Ele não publica a aplicação sem HTTPS.

## 5. Emitir o certificado

```bash
sudo LETSENCRYPT_EMAIL=seu-email@dominio.com \
  ZAPE_DOMAIN=bobia.com.br \
  ZAPE_WWW_DOMAIN=www.bobia.com.br \
  bash deploy/issue-certificate.sh --apply
```

Confirme:

```bash
sudo certbot certificates
sudo certbot renew --dry-run
```

## 6. Ativar a configuração HTTPS definitiva

```bash
sudo ZAPE_CERTIFICATE_READY=1 bash deploy/install-infrastructure.sh --apply
```

Esse comando executa `nginx -t` antes de recarregar.

## 7. Iniciar o PM2 sem root

O instalador usa o usuário `zape`. Valide:

```bash
sudo -u zape -H pm2 status
sudo -u zape -H pm2 logs bobia --lines 100
ps -eo user,pid,cmd | grep '[n]ode.*server.js'
```

O processo deve aparecer com o usuário `zape` e uma única instância.

## 8. Aplicar firewall

Não aplique sem informar sua rede de administração, pois isso pode bloquear o SSH.

```bash
sudo SSH_ALLOWED_CIDR=SEU_IP_PUBLICO/32 \
  SSH_PORT=22 \
  bash deploy/configure-firewall.sh --apply
```

Resultado esperado:

- 80 e 443 públicos;
- SSH limitado ao CIDR informado;
- 3000, 3306, 5432 e 6379 bloqueados externamente.

## 9. Verificação final

```bash
sudo ZAPE_DOMAIN=bobia.com.br bash deploy/verify-deploy.sh
```

Também confirme manualmente:

```bash
curl -I http://bobia.com.br/
curl -I https://bobia.com.br/
curl https://bobia.com.br/health
ss -ltnp | grep 3000
sudo nginx -t
sudo -u zape -H pm2 status
```

Critérios:

- HTTP retorna 301 para HTTPS;
- HTTPS apresenta certificado válido;
- HSTS aparece na resposta;
- `/health` retorna 200;
- Node escuta somente em `127.0.0.1:3000`;
- uma instância PM2 em modo fork;
- Nginx sem erro de sintaxe.

## 10. Rollback

### Código

1. Reaponte `/opt/zape/current` para a release anterior.
2. Preserve o `.env` e os diretórios compartilhados.
3. Execute:

```bash
sudo -u zape -H pm2 restart /opt/zape/current/ecosystem.config.cjs --update-env
```

### Nginx

1. Restaure a cópia anterior da configuração HTTPS.
2. Execute:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Nunca faça rollback para HTTP depois que HSTS tiver sido entregue. O rollback precisa manter um certificado válido e HTTPS funcional.

### Firewall

Mantenha 443 e o SSH administrativo liberados. Não use `ufw reset` remotamente sem uma sessão de recuperação disponível.

### Dados

Esta fase não altera schema nem conteúdo dos dados. Não restaure dados apenas para reverter a Fase 13. Um restore desnecessário pode apagar eventos criados após o deploy.

## 11. Processo de release e rollout gradual da Fase 16

O processo definitivo de release, feature flags, preflight, monitoramento e rollback está documentado em:

- `docs/phase-16-gradual-deploy.md`
- `docs/pre-deploy-checklist.md`
- `docs/rollback-plan.md`

A aplicação expõe o identificador da release em `/health` e, para `super_admin`, o estado das flags em `/api/admin/deployment`.
