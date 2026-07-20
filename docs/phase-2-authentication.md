# Fase 2 — Autenticação fail-closed, sessões e login

Data: 13/07/2026

## Objetivo

Fechar todas as rotas quando a configuração estiver ausente ou incorreta, fortalecer cookies e sessões, permitir revogação server-side e limitar ataques de força bruta sem alterar os contratos funcionais de leads, CRM, WhatsApp ou Cloud API.

## Decisões técnicas

1. Cada tenant possui flag `*_ENABLED` e par `*_USER`/`*_PASS`.
2. A ausência de credenciais nunca libera acesso.
3. O boot valida configuração antes de registrar rotas ou iniciar integrações.
4. `SESSION_SECRET` é único, obrigatório com tenant habilitado e não aceita fallback.
5. A sessão usa token HMAC com identificador aleatório de 256 bits.
6. O disco armazena somente SHA-256 do identificador da sessão.
7. Logout revoga a sessão no store antes de limpar o cookie.
8. Rate limiting possui buckets por IP, tenant/IP e tenant.
9. O IP do socket é usado por padrão. Cabeçalhos de proxy só são usados com `AUTH_TRUST_PROXY_HEADERS=1`.
10. Basic Auth permanece apenas para compatibilidade e também respeita configuração, rate limit e criação de sessão.

## Estados de acesso

| Situação | Resultado |
|---|---|
| Tenant desabilitado | HTTP 403 |
| Tenant habilitado com configuração incompleta | Boot abortado |
| Sem cookie ou Basic Auth | HTTP 401 |
| Cookie inválido, expirado ou revogado | HTTP 401 |
| Cookie de outro tenant | HTTP 401 |
| Muitas falhas | HTTP 429 com `Retry-After` |
| Sessão válida | Rota liberada com `req.auth` |

## Cookies

- `HttpOnly`
- `SameSite=Lax`
- `Path=/`
- `Priority=High`
- `Secure` obrigatório em produção
- 30 dias quando “manter conectado” está ativo
- Cookie de sessão do navegador quando a opção está desativada; validade server-side de 12 horas

## Store de sessões

Padrão: `data/auth_sessions.json`.

Campos persistidos:

- hash SHA-256 do identificador
- tenant
- usuário
- criação
- expiração
- revogação

O token completo, senha, `SESSION_SECRET` e cookie não são persistidos no store.

## Geração recomendada

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Rollback

1. Pare o processo Node.
2. Reverta os commits da Fase 2 ou aplique `zape-phase2.patch` ao contrário.
3. Remova `data/auth_sessions.json` se desejar invalidar todas as sessões criadas pela Fase 2.
4. Restaure o `.env` anterior somente em ambiente controlado.
5. Reinicie uma única instância PM2 e execute os smoke tests.

A remoção do arquivo de sessões não apaga leads, CRM, conversas, mídias ou configurações da Meta. Ela apenas força novo login.

## Limitações conhecidas

- Rate limit em memória não é compartilhado entre processos.
- Store JSON não suporta cluster ou múltiplas escritas concorrentes com garantia transacional.
- Não há papéis e permissões granulares nesta fase.
- Não há token CSRF nesta fase.
