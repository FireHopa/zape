# Ambiente de staging sintético

## Criação

```bash
npm run staging:create -- \
  --output=tmp/staging-phase15 \
  --force
```

O comando cria:

- fixture sintética para os seis tenants;
- credenciais e segredos aleatórios;
- diretórios próprios de dados, sessão, logs, auditoria, backup e offsite;
- `staging.env` com permissão 0600;
- manifesto sem valores secretos.

## Verificação

```bash
npm run staging:verify -- --env=tmp/staging-phase15/staging.env
```

O verificador exige:

- `NODE_ENV=staging`;
- marca `STAGING_SYNTHETIC_ONLY=1`;
- PostgreSQL identificado como staging;
- Redis no banco lógico 15;
- dados em diretório de staging;
- WhatsApp Web, Cloud API e CRM externo desativados;
- ausência de URL de produção.

## Serviços isolados

```bash
docker compose -f staging/docker-compose.yml up -d
```

Serviços:

- PostgreSQL 15 em `127.0.0.1:55432`;
- Redis 7 em `127.0.0.1:56379`.

O Redis é preparado para homologação futura. A fila da Fase 10 ainda usa persistência local e uma única instância.

## Homologação real das integrações

WhatsApp Web e Cloud API só podem ser ativados com:

- número exclusivo de teste;
- WABA de staging;
- token e App Secret separados;
- domínio e webhook separados;
- armazenamento e banco separados;
- nenhuma sessão ou mídia de produção.

Sem essas credenciais exclusivas, a homologação deve permanecer com integrações falsas/desativadas.
