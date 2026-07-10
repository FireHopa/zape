# Patch: recebimento de leads do sistema de WhatsApp

## O que foi implementado

- Endpoint autenticado `POST /api/integrations/zape/leads`.
- Catálogo seguro de funis em `GET /api/integrations/zape/catalog`.
- Idempotência por chave de evento.
- Deduplicação por e-mail, telefone e nome + empresa.
- Reconhecimento de telefone brasileiro e português com ou sem DDI.
- Criação de lead somente com telefone ou e-mail.
- Preservação do responsável, etapa, status, temperatura, dor e demais dados comerciais de leads existentes.
- Preenchimento apenas de campos vazios em leads existentes.
- Registro de todas as origens automáticas e quantidade de entradas.
- Histórico de auditoria com o ator **Integração WhatsApp**.
- Exibição das origens automáticas no detalhe do lead.

## Instalação

1. Substitua os arquivos deste ZIP na raiz do CRM.
2. Copie `ZAPE_INTEGRATION_KEY` de `server/.env.example` para `server/.env`.
3. Use a mesma chave em `CRM_INTEGRATION_KEY` no sistema de WhatsApp.
4. Reinicie o backend do CRM. As novas tabelas são criadas pelo schema na inicialização.
5. Depois reinicie o sistema de WhatsApp.

## Teste local

```bash
npm run test:integration
npm run build
```
