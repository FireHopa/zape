# Fase 8 — Paginação, edição de leads e consistência da API

Data: 14/07/2026

## Contrato de paginação

`GET /api/<tenant>/leads`

Parâmetros:

- `page`: página iniciada em 1.
- `pageSize`: de 1 a 500. Padrão 200.
- `sortBy`: `createdAt`, `updatedAt`, `nome`, `empresa`, `email` ou `whatsapp`.
- `sortDir`: `asc` ou `desc`.
- `q`, `ddd`, `from`, `to`, `status`, `tag`, `tags`, `origin` e `dedupe`.

Resposta:

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "pageSize": 200,
  "totalPages": 1,
  "hasNext": false,
  "hasPrev": false,
  "offset": 0,
  "sortBy": "createdAt",
  "sortDir": "desc",
  "tags": []
}
```

A tela consulta uma página por vez. CRM e campanhas percorrem todas as páginas em lotes de 500. A exportação CSV usa a mesma função de filtro, deduplicação e ordenação, mas sem aplicar paginação.

## Edição de lead

`PUT /api/<tenant>/leads/:id`

Campos editáveis:

- `nome`
- `empresa`
- `jaAnuncia`
- `website`
- `email`
- `whatsapp`
- `_version`, obrigatório para controle de concorrência

O campo `_version` é um SHA-256 determinístico dos campos editáveis e datas do registro. Se o lead tiver sido alterado por outra sessão, a API retorna:

```json
{
  "ok": false,
  "code": "LEAD_VERSION_CONFLICT",
  "error": "Este lead foi alterado em outra sessão. Recarregue os dados antes de salvar."
}
```

A edição preserva ID, tags e referências do CRM. Cada alteração é registrada em `data/<tenant>/lead_changes.jsonl` com data, ator identificado por hash, campos anteriores e campos novos.

## Conflito de telefone

Quando o novo telefone já pertence a outro lead, a API retorna HTTP 409 e não altera nenhum arquivo:

```json
{
  "ok": false,
  "code": "LEAD_PHONE_CONFLICT",
  "mergeAvailable": true,
  "conflictLeadId": "...",
  "conflictVersion": "..."
}
```

O frontend oferece merge somente após confirmação do usuário.

## Merge explícito

`POST /api/<tenant>/leads/:targetId/merge`

O corpo exige:

```json
{
  "sourceLeadId": "...",
  "targetVersion": "...",
  "sourceVersion": "...",
  "desiredPhone": "...",
  "confirm": "MERGE_LEADS"
}
```

O merge:

- mantém o lead alvo;
- remove o lead de origem;
- une tags;
- substitui referências no CRM;
- preserva etapa do funil quando necessário;
- registra campos alternativos em `mergedFieldAlternates`;
- registra IDs e origens consolidados;
- grava histórico;
- restaura os arquivos originais caso uma etapa falhe.

## Limitações atuais

- A consulta ainda carrega o arquivo JSONL inteiro em memória antes de filtrar e paginar.
- A edição reescreve o `leads.jsonl` completo.
- O controle de concorrência é por versão do registro, não por lock distribuído.
- O frontend percorre todas as páginas para CRM e campanhas. Em volumes muito maiores, essa seleção deve migrar para jobs e banco relacional.
