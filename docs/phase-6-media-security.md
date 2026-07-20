# Fase 6 — Segurança de mídias, uploads e anexos

## Objetivo

Garantir que uma mídia só seja acessada pela conversa e pelo tenant corretos, validar o conteúdo real dos arquivos, reduzir uso de memória e apresentar formatos suportados de forma segura no frontend.

## Modelo de autorização

A rota de mídia não aceita um nome físico como autorização. O backend resolve a referência na seguinte ordem:

1. tenant autenticado pelo middleware;
2. telefone normalizado presente na URL;
3. conversa pertencente ao tenant;
4. mensagem dentro dessa conversa;
5. `mediaId` ou referência legada da mensagem;
6. arquivo físico apontado pela mensagem.

Se qualquer relação não existir, a rota retorna 404. Referência válida com arquivo ausente retorna 410. O nome físico é removido da resposta JSON.

## Armazenamento

Novas mídias usam um identificador opaco aleatório de 192 bits:

```text
m_<48 caracteres hexadecimais>
```

O nome físico não contém telefone, tenant, nome original ou ID da mensagem. Arquivos são criados com permissão `0600`.

Mídias antigas não são renomeadas automaticamente. Elas continuam acessíveis somente quando existe referência explícita na conversa correta.

## Tipos permitidos

- imagens: JPEG, PNG, WebP e GIF;
- áudio: OGG/Opus, WebM, MP3, M4A/AAC, WAV e AMR;
- vídeo: MP4, WebM e QuickTime;
- PDF;
- texto e CSV;
- Word, Excel e PowerPoint legados;
- DOCX, XLSX, PPTX e formatos ODF;
- ZIP.

SVG, HTML, JavaScript, CSS, XML executável, executáveis e extensões de script são bloqueados. Pacotes Office modernos precisam conter a estrutura interna compatível com a extensão, impedindo ZIP arbitrário renomeado.

## Upload

O frontend não converte mais áudio ou arquivo para Base64. O `Blob` ou `File` é enviado diretamente no corpo HTTP:

```text
POST /api/<tenant>/conversations/<telefone>/audio
POST /api/<tenant>/conversations/<telefone>/attachments
```

Cabeçalhos:

```text
Content-Type: tipo declarado pelo navegador
X-Zape-Filename: nome codificado com encodeURIComponent
X-Zape-Caption: legenda opcional codificada
X-Zape-CSRF-Token: token da sessão
```

A requisição é transmitida para arquivo temporário com limite durante o streaming. Depois são executados:

1. validação de magic bytes;
2. comparação entre assinatura, MIME e extensão;
3. limite específico da categoria;
4. scanner antimalware, quando configurado;
5. envio pelo WhatsApp Web;
6. armazenamento local validado;
7. remoção do arquivo temporário.

O cliente legado de áudio em JSON permanece temporariamente compatível, mas recebe limite antes da decodificação e passa pela mesma validação.

## Downloads e visualização

- imagem, áudio, vídeo e PDF podem ser servidos inline;
- documentos, planilhas, apresentações, texto e ZIP usam `Content-Disposition: attachment`;
- `X-Content-Type-Options: nosniff` é obrigatório;
- recursos usam `Cross-Origin-Resource-Policy: same-origin`;
- PDFs recebem CSP sandbox;
- o nome de download é sanitizado e possui `filename*` UTF-8;
- caminhos físicos nunca são enviados ao navegador.

O frontend apresenta imagem, áudio, vídeo, PDF, documentos, planilhas e estado de mídia indisponível.

## Scanner antimalware

A integração é configurada por array JSON, sem shell:

```env
MEDIA_SCANNER_COMMAND_JSON=["clamdscan","--no-summary"]
MEDIA_SCANNER_REQUIRED=1
```

Exit code 0 significa limpo, 1 significa ameaça detectada e demais códigos são falha operacional. Quando `MEDIA_SCANNER_REQUIRED=1`, ausência ou falha do scanner bloqueia o upload.

## Retenção e quarentena

O comando abaixo é somente leitura por padrão:

```bash
npm run media:cleanup -- --data-dir=/var/lib/zape/data --retention-days=30
```

Para mover órfãos antigos para quarentena:

```bash
npm run media:cleanup -- --data-dir=/var/lib/zape/data --retention-days=30 --apply --confirm=QUARANTINE_ORPHAN_MEDIA
```

O script não exclui permanentemente. Ele move arquivos para `_media_quarantine/<runId>` e cria `manifest.json` com rollback:

```bash
npm run media:cleanup -- --rollback=/var/lib/zape/data/_media_quarantine/<runId>/manifest.json
```

## Rollout

1. aplicar código em staging;
2. testar envio de cada tipo permitido;
3. configurar ClamAV ou scanner equivalente;
4. validar limites no Nginx;
5. executar o cleanup em dry-run;
6. revisar relatório de órfãos;
7. ativar quarentena somente após backup;
8. monitorar 413, 415, 422 e 503.
