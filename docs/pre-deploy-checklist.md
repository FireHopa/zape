# Checklist de pré-deploy

## Release

- [ ] Branch e commit definidos.
- [ ] `RELEASE_ID`, `RELEASE_COMMIT` e `RELEASE_BUILT_AT` preenchidos.
- [ ] Manifesto e checksums aprovados.
- [ ] Release não contém `.env`, dados, sessões, mídias ou logs.
- [ ] Dependências instaladas por `npm ci`.
- [ ] Build gerado na própria release.

## Qualidade e segurança

- [ ] `npm test` aprovado em ambiente de teste isolado, sem integrações reais.
- [ ] `npm run quality` aprovado.
- [ ] `npm run build:web` aprovado.
- [ ] `npm run security:scan` aprovado.
- [ ] `npm run audit:permissions` aprovado.
- [ ] Audit de dependências aprovado.
- [ ] `FEATURE_AUTH_V2=1` confirmado em produção.
- [ ] CI aprovado no commit publicado.

## Dados e banco

- [ ] Backup completo criado.
- [ ] Cópia externa com checksum idêntico.
- [ ] Restore testado em ambiente separado.
- [ ] Migration executada primeiro em staging.
- [ ] Dry-run e relatório antes/depois aprovados.
- [ ] Forward fix preparado para migration irreversível.
- [ ] Jobs e campanhas em andamento revisados.

## Infraestrutura

- [ ] Certificado válido.
- [ ] `nginx -t` aprovado.
- [ ] Porta Node restrita ao loopback.
- [ ] PM2 com uma instância.
- [ ] Espaço em disco suficiente.
- [ ] Usuário `zape` possui acesso aos diretórios compartilhados.
- [ ] Firewall e acesso SSH confirmados.

## Rollout

- [ ] Flags iniciais revisadas por tenant.
- [ ] Primeiro tenant definido.
- [ ] Critérios de avanço registrados.
- [ ] Responsável pelo deploy identificado.
- [ ] Responsável pelo rollback identificado.
- [ ] Janela de observação definida.
- [ ] Comunicação com usuários preparada.
