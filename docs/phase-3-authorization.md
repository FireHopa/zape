# Fase 3: autorização e isolamento multi-tenant

Data: 13/07/2026

## Alterações implementadas

- contexto `req.auth` com usuário, tenant, papel e permissões;
- quatro papéis explícitos;
- validação das roles no boot;
- middlewares `requireAuth`, `requireRole`, `requirePermission` e `requireTenant`;
- política fail-closed para todas as rotas `/api/<tenant>`;
- conexão global da Meta restrita ao `super_admin`;
- criação de template global restrita ao `super_admin`;
- planilhas, campanhas e status Cloud isolados pelo tenant da sessão;
- status legados globais disponíveis somente ao `super_admin`;
- auditoria mínima das ações administrativas;
- testes negativos de acesso cruzado e de perfis reduzidos.

## Compatibilidade

Os tenants existentes continuam como `tenant_admin` por padrão. O `admin` continua como `super_admin`. Portanto, sem configurar variáveis `*_ROLE`, as funcionalidades existentes permanecem disponíveis aos mesmos painéis, exceto o acesso de tenants comuns à configuração global da Meta, que agora retorna 403 por segurança.

## Rollback

1. Reverta os commits da Fase 3.
2. Remova as variáveis `*_ROLE` e `SECURITY_AUDIT_FILE` se tiverem sido adicionadas.
3. Não apague `security_audit.jsonl`; ele é evidência técnica e pode ser arquivado.
4. Reinicie uma única instância PM2.

O rollback reabre o risco anterior de qualquer tenant autenticado alterar ou desconectar a conexão global da Meta.
