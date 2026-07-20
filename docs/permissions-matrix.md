# Matriz de papéis, permissões e isolamento multi-tenant

Data: 13/07/2026
Fase: 3

## 1. Princípio de segurança

O tenant efetivo sempre é obtido da sessão autenticada em `req.auth.tenantId`. Valores enviados em query string, body, headers ou pelo frontend não alteram o tenant do usuário.

O contexto autenticado possui este formato:

```js
req.auth = {
  userId,
  tenantId,
  username,
  role,
  permissions,
  sessionId,
  method
}
```

## 2. Papéis

| Papel | Escopo | Uso recomendado |
|---|---|---|
| `super_admin` | Global | Administração técnica da plataforma e da conexão compartilhada da Meta. Reservado ao tenant `admin`. |
| `tenant_admin` | Tenant | Administração completa dos recursos operacionais do próprio tenant. |
| `operator` | Tenant | Operação diária, criação de leads, CRM, conversas e campanhas, sem exclusões nem configurações críticas. |
| `viewer` | Tenant | Consulta, dashboards, status, conversas e recursos somente leitura. |

Padrões atuais:

| Tenant | Papel padrão |
|---|---|
| `admin` | `super_admin` |
| `panel` | `tenant_admin` |
| `regina` | `tenant_admin` |
| `portugal` | `tenant_admin` |
| `felipe` | `tenant_admin` |
| `ana` | `tenant_admin` |

O papel pode ser reduzido com `<TENANT>_ROLE`. Um tenant diferente de `admin` não pode receber `super_admin`; o boot é bloqueado quando isso ocorre.

## 3. Matriz resumida

| Recurso ou ação | super_admin | tenant_admin | operator | viewer |
|---|:---:|:---:|:---:|:---:|
| Abrir painel próprio | Sim | Sim | Sim | Sim |
| Consultar leads | Sim | Sim | Sim | Sim |
| Criar lead manual | Sim | Sim | Sim | Não |
| Editar ou unir leads | Sim | Sim | Sim | Não |
| Excluir lead | Sim | Sim | Não | Não |
| Exportar leads | Sim | Sim | Não | Não |
| Consultar CRM | Sim | Sim | Sim | Sim |
| Alterar CRM | Sim | Sim | Sim | Não |
| Consultar WhatsApp Web | Sim | Sim | Sim | Sim |
| Iniciar ou reconectar WhatsApp Web | Sim | Sim | Não | Não |
| Enviar texto ou áudio | Sim | Sim | Sim | Não |
| Consultar insights | Sim | Sim | Sim | Sim |
| Consultar tags | Sim | Sim | Sim | Sim |
| Criar ou excluir tags | Sim | Sim | Não | Não |
| Consultar template local | Sim | Sim | Sim | Sim |
| Alterar template local | Sim | Sim | Não | Não |
| Consultar webhooks | Sim | Sim | Sim | Sim |
| Criar, editar ou excluir webhooks | Sim | Sim | Não | Não |
| Consultar CRM externo | Sim | Sim | Sim | Sim |
| Consultar dados institucionais | Sim | Sim | Sim | Sim |
| Alterar dados institucionais globais | Sim | Não | Não | Não |
| Consultar conexão global Meta | Sim | Não | Não | Não |
| Alterar, conectar ou desconectar Meta | Sim | Não | Não | Não |
| Criar template na conta compartilhada Meta | Sim | Não | Não | Não |
| Listar templates compartilhados | Sim | Sim | Sim | Sim |
| Enviar campanha do próprio tenant | Sim | Sim | Sim | Não |
| Consultar planilhas do próprio tenant | Sim | Sim | Sim | Sim |
| Criar ou excluir planilhas do próprio tenant | Sim | Sim | Sim | Não |
| Consultar status do próprio tenant | Sim | Sim | Sim | Sim |

## 4. WhatsApp Cloud API compartilhada

A conexão Meta permanece global nesta fase. Por esse motivo:

1. Somente `super_admin` acessa os IDs, estado detalhado, Embedded Signup e desconexão da conta.
2. Templates da conta podem ser listados pelos tenants autorizados, mas a criação de template é global e fica restrita ao `super_admin`.
3. Cada campanha recebe `tenantId` obtido da sessão.
4. Planilhas são armazenadas em `data/<tenant>/wa_cloud_saved_sheets.json`.
5. O endpoint de status retorna somente eventos de campanha do tenant autenticado.
6. Status legados sem tenant aparecem somente para o `super_admin`, identificados como `legacy`.
7. Query ou body com `tenant=admin` não altera o tenant efetivo.

## 5. Política fail-closed para rotas

Rotas sob `/api/<tenant>` passam por uma política central. Quando uma nova rota autenticada não possui permissão mapeada, a resposta é HTTP 403 com `ROUTE_POLICY_MISSING`.

Isso evita a abertura acidental de uma nova rota por ausência de middleware específico.

Comando de auditoria:

```bash
npm run audit:permissions
```

## 6. Auditoria administrativa

As seguintes ações geram registro JSONL sem nome de usuário em texto puro:

- alteração dos dados institucionais globais;
- alteração de configuração do Embedded Signup;
- code exchange e substituição de conexão;
- desconexão da Cloud API;
- criação de template global;
- criação de campanha oficial.

O ator é identificado por hash SHA-256. O caminho padrão é `data/security_audit.jsonl`, podendo ser alterado por `SECURITY_AUDIT_FILE`.

## 7. Limitações remanescentes

- Ainda existe um único usuário configurado por tenant. Usuários individuais e múltiplos operadores serão modelados no banco relacional.
- A conexão Cloud continua compartilhada.
- A correlação definitiva de respostas por `phone_number_id`, `context.id` e Meta message ID pertence à Fase 9.
- A trilha de auditoria completa, retenção e monitoramento pertencem à Fase 12.
