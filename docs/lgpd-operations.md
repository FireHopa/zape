# Operações LGPD

## Exportação

A exportação retorna os dados localizados para um contato dentro do tenant autenticado. A consulta é auditada e a resposta utiliza `Cache-Control: no-store`.

## Exclusão

1. Executar dry-run.
2. Revisar contagens e referências.
3. Confirmar obrigações legais de retenção.
4. Criar backup válido.
5. Aplicar com `DELETE_CONTACT_DATA`.
6. Verificar auditoria e quarentena.

## Segurança

- O telefone não é salvo em texto puro nos logs ou na auditoria.
- O tenant é obtido da sessão.
- `viewer` não possui permissão de gestão de privacidade.
- No banco, a operação é transacional.
- No JSON, os arquivos anteriores ficam em quarentena para rollback controlado.
