# Fase 13 — HTTPS, Nginx, PM2 e hardening de infraestrutura

Data: 13/07/2026

## Objetivo

Proteger o tráfego externo, impedir acesso direto ao processo Node, limitar a confiança em proxies, executar a aplicação sem privilégios e tornar o deploy verificável e reversível.

## Arquitetura resultante

```text
Internet
  └── TCP 80/443
      └── Nginx
          ├── HTTP 80: ACME + redirect 301 para HTTPS
          ├── HTTPS 443: TLS 1.2/1.3 + HSTS
          ├── limites por rota, IP, conexão e payload
          └── proxy para 127.0.0.1:3000
              └── Node/Express em PM2, usuário zape, uma instância fork
```

A porta 3000 não deve responder em endereços externos. Banco, Redis e demais serviços internos também não devem receber regras públicas de firewall.

## Mudanças aplicadas

### Runtime Node

- `HOST` passa a controlar o endereço de bind.
- Produção aceita somente loopback, preferencialmente `127.0.0.1`.
- `TRUST_PROXY_HOPS` aceita somente inteiro de 0 a 5.
- Produção com o Nginx fornecido exige um salto confiável.
- `trust proxy=true` foi removido.
- `PUBLIC_BASE_URL` é obrigatória e deve usar HTTPS em produção.
- O boot recusa execução como root em produção.
- `INFRA_ALLOW_ROOT_PROCESS=1` existe somente para testes controlados e gera aviso explícito.
- O rate limit usa `req.ip`, calculado pelo Express após a política de proxy, e não o valor bruto do header recebido.
- O servidor fecha novas conexões antes de encerrar workers e clientes WhatsApp.
- PM2 recebe sinal `ready` e mensagem de shutdown.

### Nginx

- HTTP redireciona para HTTPS.
- ACME webroot permanece acessível para emissão e renovação.
- TLS 1.2 e 1.3.
- HSTS por 365 dias, sem `preload` e sem `includeSubDomains`.
- Host desconhecido retorna 444.
- O upstream é fixo em `127.0.0.1:3000`.
- `X-Forwarded-For` recebido do cliente é substituído por `$remote_addr`.
- `X-Forwarded-Host` não é encaminhado.
- WebSocket/upgrade permanece preparado.
- Rate limit adicional para login, formulário e webhooks.
- Limite de conexão por IP.
- Limites de corpo específicos:
  - health: 16 KB;
  - login: 128 KB;
  - formulário público: 512 KB;
  - webhooks comuns: 1 MB;
  - Meta: 2 MB;
  - rotas autenticadas atuais: 64 MB.
- O limite autenticado de 64 MB é temporário e acompanha o parser atual de 60 MB. A Fase 6 deve substituí-lo por limites por tipo e streaming.
- O formato de acesso dos webhooks mascara o token legado presente em `/webhooks/:token`.
- Query strings não são registradas no formato de acesso.

### PM2

- `exec_mode: fork`.
- `instances: 1`.
- Bind em `127.0.0.1`.
- Limite padrão de memória em 1 GB.
- Backoff de reinicialização.
- `wait_ready` e `listen_timeout`.
- `kill_timeout` de 90 segundos.
- Logs fora da pasta de release.
- Watch e cluster desabilitados.

A instância única é obrigatória enquanto WhatsApp Web, sessões e stores permanecerem locais.

### Sistema operacional

Arquivos de deploy criados:

- `deploy/install-infrastructure.sh`
- `deploy/issue-certificate.sh`
- `deploy/configure-firewall.sh`
- `deploy/verify-deploy.sh`
- `deploy/logrotate-zape`

Todos os scripts destrutivos ou administrativos operam em dry-run por padrão. A execução exige `--apply`.

Diretórios recomendados:

```text
/opt/zape/current
/var/lib/zape/data
/var/log/zape
/var/backups/zape
```

Permissões recomendadas:

- usuário e grupo: `zape`;
- diretórios operacionais: `0750`;
- `.env`: `0600`;
- processo Node: usuário `zape`, nunca root.

## Arquivos Nginx

- `nginx/zape-http.conf`: maps, zonas de rate limit, limite de conexão e formatos de log.
- `nginx/snippets/zape-proxy-common.conf`: proxy seguro para loopback.
- `nginx/casa-do-ads-bootstrap.conf`: primeira emissão do certificado.
- `nginx/casa-do-ads.conf`: configuração HTTPS definitiva para `bobia.com.br`.
- `nginx/templates/casa-do-ads.conf.template`: template para outro domínio.

Renderização para outro domínio:

```bash
node scripts/render-infrastructure-config.js \
  --domain=seu-dominio.com.br \
  --output=nginx/rendered/casa-do-ads.conf
```

## Validações

```bash
npm run infra:validate
npm run test:phase13-smoke
npm run test:phase13-nginx
npm test
npm run check:syntax
npm run build:web
npm run security:scan
npm run audit:permissions
```

`infra:validate` executa:

- auditoria estática dos arquivos;
- validação da configuração runtime;
- `bash -n` nos scripts;
- carregamento do `ecosystem.config.cjs`;
- `nginx -t` com certificado sintético temporário.

O smoke da Fase 13 comprova:

- `/health` em HTTP local retorna 200;
- bind em loopback;
- porta inacessível pelo endereço não-loopback;
- encerramento limpo por SIGTERM;
- validação Nginx aprovada.

O smoke dinâmico do Nginx sobe uma instância temporária com certificado sintético e comprova:

- redirect HTTP 301;
- resposta HTTPS 200;
- HSTS presente;
- `X-Forwarded-For` forjado substituído pelo IP real do socket;
- ausência de `X-Forwarded-Host`;
- token do webhook mascarado no access log;
- host desconhecido rejeitado.

## Riscos remanescentes

- HSTS é persistido no navegador. Depois de habilitado, um rollback deve preservar HTTPS.
- O limite geral de 64 MB permanece alto até a Fase 6.
- Rate limiting da aplicação continua em memória e não é compartilhado.
- Logs e auditoria avançada pertencem à Fase 12.
- Banco e Redis ainda não fazem parte da aplicação, mas o firewall já os mantém privados.
- A configuração fornecida usa `bobia.com.br`; outro domínio deve ser renderizado e revisado antes do deploy.
- Certificado real, DNS e firewall do servidor precisam ser aplicados no ambiente de produção por operador autorizado.
