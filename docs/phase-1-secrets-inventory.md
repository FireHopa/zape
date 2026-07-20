# Inventário sanitizado de segredos e dados

Data da análise: 13/07/2026

## Escopo analisado

- código-fonte
- arquivos JSON e JSONL
- configuração do PM2 e Nginx
- documentação
- diretórios de mídia
- backups locais incluídos no pacote
- pacote ZIP original
- repositório Git local

## Achados confirmados no pacote original

| Tipo | Local | Situação |
|---|---|---|
| Meta App Secret | `data/wa_cloud_config.json` | valor não reproduzido; considerar comprometido |
| Token de webhook customizado | `data/webhooks.json` | 70 registros em texto puro; valores não reproduzidos |
| Dados pessoais de leads e conversas | `data/` | excluídos do projeto sanitizado |
| Mídias e documentos reais | `data/*/conversation_media/` | 710 arquivos identificados; excluídos do projeto sanitizado |
| Backup de leads | `data/admin/leads.jsonl.bak` | excluído do projeto sanitizado |
| Segredo de sessão inseguro | `src/basicAuthFactory.js` | removidas derivações por senha, URL e fallback fixo |
| Logs com lead completo | `server.js` | substituídos por ID e fingerprint |
| Debug de headers e body | `POST /debug/active` | conteúdo deixou de ser registrado; remoção da rota permanece para a Fase 4 |

## Histórico Git

O repositório recebido não possuía commits acessíveis. Não havia histórico versionado para reescrever. O ZIP original, no entanto, contém dados e deve ser tratado como artefato sensível.

## Decisões aplicadas

- segredos persistentes criptografados com AES-256-GCM
- chave de criptografia fornecida exclusivamente por variável de ambiente
- formatos legados detectados e bloqueados por padrão
- migração explícita com dry-run, backup, idempotência e rollback
- tokens de webhook gerados com CSPRNG
- logs com redaction e fingerprints
- exportação sanitizada com allowlist operacional e varredura automática
- hook pre-commit opcional para bloquear novos segredos

## Ações externas obrigatórias

- rotacionar App Secret da Meta
- rotacionar todos os tokens de webhook customizados
- rotacionar senhas dos tenants
- rotacionar token da Cloud API, verify token e chave do CRM se já estiveram no pacote original
- apagar cópias públicas ou compartilhadas do ZIP original
