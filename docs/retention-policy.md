# Política técnica de retenção

Os valores padrão são técnicos e devem ser aprovados pelo controlador e pelo jurídico antes do deploy.

| Categoria | Padrão |
|---|---:|
| Logs operacionais | 30 dias |
| Auditoria | 365 dias |
| Exports | 7 dias |
| Backups | 30 dias |
| Eventos de webhook | 30 dias |
| Status de mensagens | 180 dias |
| Eventos Cloud | 180 dias |
| Mídias | 365 dias |
| Jobs | 30 dias |

A exclusão operacional usa quarentena e manifesto. Nenhum arquivo é apagado de forma permanente pelo comando de retenção desta fase.
