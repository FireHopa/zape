# Backup e restauração

## Requisitos

- `BACKUP_ENCRYPTION_KEY` ou `CONFIG_ENCRYPTION_KEY` com 32 bytes.
- Diretório local com permissão restrita.
- Destino externo montado em `BACKUP_REMOTE_DIRECTORY` em produção.
- Banco e storage de restauração separados do ambiente ativo.

## Garantias

- AES-256-GCM.
- Manifesto com SHA-256 por arquivo.
- Checksum do arquivo criptografado.
- Verificação da cópia externa.
- Restauração bloqueada sem confirmação literal.
- Validação integral do manifesto após extração.

## Limitação

O backup lógico da aplicação não substitui `pg_dump`, WAL archiving e política de backup físico do PostgreSQL. Esses mecanismos devem coexistir em produção.
