# Fase 5: XSS, CSP, CORS, CSRF e hardening do frontend

Data: 13/07/2026

## Escopo executado

A fase protege o navegador e as operações autenticadas sem alterar contratos de API, dados ou regras de negócio. O frontend monolítico continua funcional, mas scripts e estilos foram separados para permitir uma política CSP aplicável.

## Inventário de sinks

O comando abaixo gera um inventário reproduzível:

```bash
npm run audit:frontend-security
```

Resultado da implementação:

- 168 atribuições a `innerHTML`.
- 98 usos de `textContent`.
- 0 usos de `document.write`.
- 0 usos de `insertAdjacentHTML`.
- 0 usos de `eval`.
- 0 usos de `new Function`.
- 62 atributos `style` no HTML estático.
- 39 atributos `style` em fragmentos internos de interface.

### Classificação

1. **Markup interno constante**
   - botões, estados vazios, tabelas, ícones e componentes definidos pelo próprio sistema;
   - não recebe HTML do usuário.

2. **Dados de API, lead, CRM, webhook, mensagem e arquivo**
   - valores textuais passam por `escapeHtml`, `textContent` ou criação explícita de elementos;
   - o modal de detalhes do CRM foi migrado para `createElement` e `textContent`;
   - cores de tags passam por allowlist de formato CSS;
   - URLs dinâmicas passam por validação de protocolo e origem.

3. **Fragmentos legados mistos**
   - continuam usando `innerHTML` para preservar a interface atual;
   - todos os sinks são protegidos por Trusted Types com uma policy padrão baseada em DOMPurify;
   - navegadores sem Trusted Types recebem um fallback que sanitiza `innerHTML` e `insertAdjacentHTML`.

Nenhum HTML fornecido pelo usuário é aceito como conteúdo rico. Tags `script`, `style`, `iframe`, `object`, `embed`, `svg`, `math`, `base`, `meta`, `link` e `form` são removidas da sanitização dinâmica.

## Separação dos arquivos do frontend

Antes:

- `public/app.html` continha 27 blocos de estilo e 3 blocos de script inline.

Depois:

- `public/app.html`: estrutura HTML;
- `public/app.css`: CSS consolidado;
- `public/app.js`: JavaScript consolidado;
- `public/security-bootstrap.js`: Trusted Types, DOMPurify, validação de URL e wrapper seguro de `fetch`;
- `public/login.css` e `public/login.js`: login sem CSS ou JavaScript inline;
- `/vendor/dompurify.min.js`: entregue pelo backend a partir da dependência instalada `dompurify`;
- `/vendor/phosphor/`: entregue pelo backend a partir da dependência instalada `@phosphor-icons/web`, sem copiar binários de fonte para o repositório.

## Content Security Policy

A CSP é adicionada pelo Helmet com as principais restrições:

- `default-src 'self'`;
- `object-src 'none'`;
- `frame-ancestors 'none'`;
- `form-action 'self'`;
- `script-src-attr 'none'`;
- scripts somente do próprio sistema, SDK oficial do Facebook e CDN do XLSX legado;
- estilos em elementos somente do próprio sistema e Google Fonts;
- `trusted-types default dompurify`;
- `require-trusted-types-for 'script'`.

### Exceção temporária de estilos

`style-src-attr 'unsafe-inline'` permanece porque o frontend legado ainda possui 101 atributos `style` usados para layout e estados visuais. A exceção foi limitada a atributos. Blocos `<style>` inline continuam bloqueados.

A remoção dos atributos inline deve ocorrer durante a modularização gradual da Fase 14.

## CORS

O `app.use(cors())` irrestrito foi removido.

- Same-origin funciona sem configuração adicional.
- Origens extras devem ser listadas explicitamente em `APP_ALLOWED_ORIGINS`.
- A allowlist também aceita o alias `CORS_ALLOWED_ORIGINS`.
- `*` não é interpretado como origem válida.
- Credenciais só recebem `Access-Control-Allow-Origin` para uma origem presente na allowlist.

## CSRF e validação de origem

No login bem-sucedido, o servidor cria um token aleatório de 256 bits no cookie `zape_csrf`:

- `SameSite=Strict`;
- `Secure` em produção;
- não contém usuário, tenant ou dado pessoal;
- é legível pelo JavaScript para o padrão double-submit cookie.

O wrapper de `fetch` adiciona automaticamente:

```text
X-Zape-CSRF-Token: <token do cookie>
X-Requested-With: Zape
```

A proteção cobre métodos de escrita em `/api/*` e `/auth/logout`.

Exceções intencionais:

- `/api/leads` público usa token próprio, limite e idempotência;
- webhooks usam HMAC, assinatura Meta, timestamp, event ID e idempotência;
- `/auth/login` ainda não possui sessão, mas exige `Origin` ou `Referer` autorizado.

Uma operação crítica é rejeitada quando:

- a origem está ausente;
- a origem não é same-origin nem está na allowlist;
- o cookie CSRF está ausente;
- o header CSRF está ausente;
- cookie e header não são iguais em comparação timing-safe.

## Validação de URLs

O frontend bloqueia protocolos inesperados.

Permitidos conforme o contexto:

- `http:` e `https:`;
- same-origin por padrão;
- `blob:` apenas para downloads e prévias locais controladas;
- `data:image/...;base64` apenas para imagens aprovadas;
- `data:audio/...;base64` apenas para prévias de áudio aprovadas.

Bloqueados:

- `javascript:`;
- `data:text/html`;
- protocolos desconhecidos;
- caracteres de controle;
- origem externa quando o sink exige same-origin.

## Headers adicionais

- `X-Frame-Options: DENY`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: strict-origin-when-cross-origin`;
- `Permissions-Policy` restritiva;
- `Cross-Origin-Opener-Policy: same-origin`;
- `Cross-Origin-Resource-Policy: same-origin`;
- páginas autenticadas e APIs com `Cache-Control: no-store`.

HSTS permanece desativado nesta fase. Deve ser ativado somente após HTTPS validado na Fase 13.

## Testes de regressão

Os testes cobrem:

- CSP e Trusted Types presentes;
- HTML e login sem scripts ou blocos de estilo inline;
- CORS sem reflexão arbitrária;
- origem permitida e origem maliciosa;
- token CSRF ausente, divergente e válido;
- payloads `<img onerror>`, `<svg onload>`, `<script>` e `javascript:`;
- detalhes do lead renderizados como texto;
- URL dinâmica bloqueada;
- ausência de execução e de diálogos no Chromium.

## Rollback

1. Reverter os commits da Fase 5.
2. Restaurar `public/app.html` da Fase 4.
3. Remover `public/app.css`, `public/app.js`, arquivos de bootstrap e vendors adicionados.
4. Restaurar o middleware CORS anterior apenas durante rollback emergencial.
5. Reiniciar uma única instância PM2.

O rollback remove CSP, CSRF e sanitização central. Portanto, deve ser apenas emergencial e temporário.
