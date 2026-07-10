# Patch: sistema de WhatsApp → CRM Inteligente

## O que foi implementado

- Envio por webhook somente quando a integração estiver ativada naquela origem.
- Configuração de funil, etapa e origem diretamente na tela de webhooks.
- Fila persistente em `data/external_crm_queue.json`.
- Retentativas sem interromper o cadastro nem as mensagens do WhatsApp.
- Idempotência local por `tenantId + leadId`.
- Leads automáticos aceitos somente com telefone válido.
- Suporte a telefones do Brasil e de Portugal.
- Consulta segura do catálogo de funis do CRM sem expor a chave no navegador.
- ActiveCampaign mantida como fonte de entrada. O fluxo é unidirecional: ActiveCampaign → sistema de WhatsApp → CRM Inteligente.
- O endpoint `/webhooks/activecampaign` permanece sempre disponível para receber dados.
- Leads recebidos pela rota fixa da ActiveCampaign também seguem ao CRM por padrão.

## Instalação

1. Substitua os arquivos deste ZIP na raiz do sistema de WhatsApp.
2. Copie as variáveis de `.env.example` para o `.env` real do servidor.
3. Configure `CRM_INTEGRATION_URL` com a URL pública do CRM.
4. Configure `CRM_INTEGRATION_KEY` com a mesma chave usada no CRM.
5. Reinicie o processo Node/PM2.
6. Abra **Entrada automática**, selecione um webhook e ative **Enviar também para o CRM Inteligente**.

A integração fica desligada por padrão apenas nos webhooks configuráveis existentes e novos. A rota fixa `/webhooks/activecampaign` continua recebendo normalmente e envia ao CRM por padrão quando a integração global está configurada.

## Teste local

```bash
npm run test:crm-integration
node --check server.js
```
