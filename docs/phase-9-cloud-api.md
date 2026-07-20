# Fase 9 — WhatsApp Cloud API e correlação de eventos

## Objetivo

Tornar a conexão oficial diagnosticável, isolada por tenant e capaz de correlacionar status e respostas sem heurística por telefone.

## Identidade da conexão

A conexão recebe um `connectionId` determinístico derivado de `Phone Number ID + WABA ID`. O valor não contém token e muda quando a conexão efetiva muda.

O tenant proprietário é configurado por `WA_CLOUD_CONNECTION_OWNER_TENANT`. A administração da conexão continua restrita ao `super_admin`.

## Health check

Rota:

```text
GET /api/wa-cloud/health
```

Permissão: `super_admin` com `cloud.connection.view`.

Validações:

1. Integração habilitada.
2. Access token presente.
3. Phone Number ID presente e acessível.
4. WABA ID presente e acessível.
5. Graph API version válida.
6. Verify token presente.
7. Número com indício de registro válido.
8. Aplicativo inscrito em `subscribed_apps`.
9. Templates consultáveis.
10. Token válido por `debug_token` quando App ID e App Secret estão disponíveis.

Nenhum access token ou App Secret é devolvido.

## Erro #133010

O erro `Account not registered` é classificado como não retentável. A orientação operacional é conferir o número no WhatsApp Manager, registrar o número na Cloud API, validar o Phone Number ID e refazer o vínculo quando necessário.

O erro não é atribuído ao lead e não entra em retry automático infinito.

## Estados

Fluxo normal:

```text
queued -> submitted -> sent -> delivered -> read -> replied
```

Estados terminais adicionais:

- `failed`
- `expired`
- `canceled`

A aplicação aceita saltos quando a Meta entrega webhooks fora de ordem, por exemplo `submitted -> delivered`, mas rejeita regressão `delivered -> sent` e `read -> delivered`. Repetições não duplicam o histórico.

## Correlação de status

Status são localizados por:

```text
connectionId + Meta message ID
```

A atualização também valida o destinatário e o Phone Number ID quando disponíveis. Um message ID não pode pertencer a dois disparos da mesma conexão.

## Correlação de respostas

Ordem segura:

1. Resolver a conexão por `metadata.phone_number_id` e WABA.
2. Ler `messages[].context.id`.
3. Buscar o disparo por `connectionId + context.id`.
4. Confirmar que o remetente da resposta corresponde ao destinatário do disparo.
5. Marcar exatamente aquele evento como `replied`.

Sem `context.id`, a resposta é persistida como `unmatched` e nenhuma campanha é marcada. Isso evita atribuição errada quando o mesmo contato recebeu campanhas de tenants ou campanhas diferentes.

## Rollout

1. Publicar primeiro em staging.
2. Usar conta, aplicativo, WABA e número exclusivos de homologação.
3. Executar o health check.
4. Enviar um template aprovado para um contato de teste.
5. Confirmar estados `submitted`, `sent`, `delivered` e `read`.
6. Responder à mensagem citando-a para gerar `context.id`.
7. Verificar que somente o tenant correto recebe `replied`.
8. Testar um webhook com Phone Number ID incorreto e confirmar HTTP 403.

## Rollback

Reverter os commits da fase restaura o código anterior. Antes de reverter, preservar `wa_cloud_dispatches.json`, porque a versão 2 contém histórico e eventos não correlacionados que o código anterior não compreende integralmente.
