# Plano de rollback e forward fix

## Código

- Reapontar `current` para `previous`.
- Reiniciar PM2 com a configuração da release reativada.
- Confirmar `/health` e `RELEASE_ID`.
- Manter HTTPS e certificado válidos.

## Configuração

- Versionar uma cópia redigida da configuração esperada.
- Fazer backup do `.env`, Nginx e ecosystem antes do deploy.
- Restaurar somente a configuração compatível com a release anterior.
- Nunca copiar segredos para logs ou tickets.

## Banco

- Não fazer rollback automático.
- Preservar dados criados depois do deploy.
- Preferir forward fix.
- Restore completo exige janela separada, aprovação e análise dos registros posteriores.

## Filas e campanhas

- Pausar novos jobs antes da troca.
- Preservar Meta message IDs e cursores.
- Não reenviar itens com resultado incerto.
- Confirmar dead-letter e jobs `inFlight` antes do rollback.

## Nginx e PM2

- Restaurar Nginx somente após `nginx -t`.
- Não voltar para HTTP.
- Manter uma única instância PM2.
- Validar usuário não-root e diretórios compartilhados.
