const auth = require("basic-auth");
const crypto = require("crypto");

const TENANT_CONFIGS = {
  admin: { userEnv: "ADMIN_USER", passEnv: "ADMIN_PASS", realm: "Admin", path: "/admin" },
  panel: { userEnv: "PANEL_USER", passEnv: "PANEL_PASS", realm: "Panel", path: "/panel" },
  regina: { userEnv: "REGINA_USER", passEnv: "REGINA_PASS", realm: "Painel da Regina", path: "/regina" },
};

function tenantFromEnv(userEnv) {
  return String(userEnv || "").replace(/_USER$/i, "").toLowerCase();
}

function getTenantConfig(tenantId) {
  return TENANT_CONFIGS[String(tenantId || "").toLowerCase()] || null;
}

function getSecret() {
  const raw = [
    process.env.SESSION_SECRET,
    process.env.AUTH_SECRET,
    process.env.ADMIN_PASS,
    process.env.PANEL_PASS,
    process.env.REGINA_PASS,
    process.env.PUBLIC_BASE_URL,
    process.env.APP_BASE_URL,
  ].filter(Boolean).join("|");

  return raw || "zape-local-dev-secret";
}

function parseCookies(req) {
  const header = String(req.headers.cookie || "");
  const out = {};
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (!key) return;
    try { out[key] = decodeURIComponent(val); }
    catch { out[key] = val; }
  });
  return out;
}

function cookieName(tenantId) {
  return `zape_auth_${String(tenantId || "").toLowerCase()}`;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(payload) {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

function createToken({ tenantId, username, days = 30 }) {
  const maxDays = Math.max(1, Math.min(Number(days || 30), 90));
  const payload = JSON.stringify({
    tenantId,
    username,
    exp: Date.now() + maxDays * 24 * 60 * 60 * 1000,
  });
  const encoded = base64url(payload);
  return `${encoded}.${sign(encoded)}`;
}

function readToken(req, tenantId) {
  const cookies = parseCookies(req);
  const token = cookies[cookieName(tenantId)];
  if (!token || !token.includes(".")) return null;

  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;

  const expected = sign(encoded);
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload || payload.tenantId !== tenantId) return null;
    if (!payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function isSecureRequest(req) {
  const xfProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
  return req.secure || xfProto === "https";
}

function setAuthCookie(res, req, tenantId, token, maxAgeDays = 30) {
  const attrs = [
    `${cookieName(tenantId)}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(1, Number(maxAgeDays || 30)) * 24 * 60 * 60}`,
  ];
  if (isSecureRequest(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearAuthCookie(res, req, tenantId) {
  const attrs = [
    `${cookieName(tenantId)}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isSecureRequest(req)) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

function wantsHtml(req) {
  const accept = String(req.get("accept") || "");
  return req.method === "GET" && accept.includes("text/html") && !req.originalUrl.startsWith("/api/");
}

function normalizeAuthValue(value) {
  // Evita falha por espaço acidental no .env ou no preenchimento do campo.
  // Ex.: PANEL_PASS=senha + espaço no final.
  return String(value ?? "").trim();
}

function checkCredentials(tenantId, username, password) {
  const cfg = getTenantConfig(tenantId);
  if (!cfg) return { ok: false, reason: "invalid_tenant", configured: false };

  const expectedUserRaw = process.env[cfg.userEnv];
  const expectedPassRaw = process.env[cfg.passEnv];
  const expectedUser = normalizeAuthValue(expectedUserRaw);
  const expectedPass = normalizeAuthValue(expectedPassRaw);

  // Mantém compatibilidade com o comportamento antigo em dev/local:
  // sem usuário/senha no .env, o acesso fica liberado.
  if (!expectedUser || !expectedPass) {
    return { ok: true, reason: "unconfigured", configured: false, userOk: true, passOk: true };
  }

  const providedUser = normalizeAuthValue(username);
  const providedPass = normalizeAuthValue(password);
  const userOk = providedUser === expectedUser;
  const passOk = providedPass === expectedPass;

  return {
    ok: userOk && passOk,
    reason: userOk && passOk ? "ok" : "mismatch",
    configured: true,
    userOk,
    passOk,
  };
}

function verifyCredentials(tenantId, username, password) {
  return checkCredentials(tenantId, username, password).ok;
}

function logAuthAttempt(req, tenantId, username, check) {
  const enabled = String(process.env.DEBUG_AUTH || process.env.DEBUG || "").toLowerCase();
  // Quando DEBUG_AUTH=0, não loga. Caso contrário, loga só o resumo seguro do login.
  if (enabled === "0" || enabled === "false" || enabled === "off") return;

  const ip = req.ip || req.get("x-forwarded-for") || "";
  const safeUser = normalizeAuthValue(username);
  console.log(
    `[AUTH] login tenant=${tenantId} user="${safeUser}" ok=${Boolean(check?.ok)} configured=${Boolean(check?.configured)} userOk=${Boolean(check?.userOk)} passOk=${Boolean(check?.passOk)} ip=${ip}`
  );
}

function unauthorized(req, res, realm, tenantId) {
  if (wantsHtml(req)) {
    const next = encodeURIComponent(req.originalUrl || getTenantConfig(tenantId)?.path || "/");
    return res.redirect(`/login?tenant=${encodeURIComponent(tenantId)}&next=${next}`);
  }

  res.set("WWW-Authenticate", `Basic realm="${realm || "Protected"}"`);
  return res.status(401).json({ ok: false, error: "Unauthorized", login: `/login?tenant=${tenantId}` });
}

/**
 * Auth middleware com cookie persistente + compatibilidade com Basic Auth.
 * Se env vars estiverem ausentes, libera o acesso como antes (dev/local).
 */
function makeBasicAuth({ userEnv, passEnv, realm }) {
  const tenantId = tenantFromEnv(userEnv);

  return function persistentAuthMiddleware(req, res, next) {
    const expectedUser = normalizeAuthValue(process.env[userEnv]);
    const expectedPass = normalizeAuthValue(process.env[passEnv]);

    if (!expectedUser || !expectedPass) return next();

    const session = readToken(req, tenantId);
    if (session) {
      req.auth = { tenantId, username: session.username, method: "cookie" };
      return next();
    }

    const creds = auth(req);
    const basicUser = creds ? normalizeAuthValue(creds.name) : "";
    const basicPass = creds ? normalizeAuthValue(creds.pass) : "";
    if (creds && basicUser === expectedUser && basicPass === expectedPass) {
      const token = createToken({ tenantId, username: basicUser, days: 30 });
      setAuthCookie(res, req, tenantId, token, 30);
      req.auth = { tenantId, username: basicUser, method: "basic" };
      return next();
    }

    return unauthorized(req, res, realm, tenantId);
  };
}

function anyTenantAuth(req, res, next) {
  const tenantIds = Object.keys(TENANT_CONFIGS);
  const configured = tenantIds.filter((tenantId) => {
    const cfg = getTenantConfig(tenantId);
    return process.env[cfg.userEnv] && process.env[cfg.passEnv];
  });

  if (!configured.length) return next();

  for (const tenantId of tenantIds) {
    const session = readToken(req, tenantId);
    if (session) {
      req.auth = { tenantId, username: session.username, method: "cookie" };
      return next();
    }
  }

  return unauthorized(req, res, "Protected", "admin");
}

function renderLoginPage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Entrar • Zape</title>
  <style>
    :root{--bg:#f6f8fc;--card:#fff;--text:#111827;--muted:#64748b;--line:#e5e7eb;--blue:#2563eb;--blue2:#1d4ed8;--red:#dc2626;--shadow:0 24px 70px rgba(15,23,42,.12)}
    *{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 0%,#e8f0fe 0,#f6f8fc 32%,#f8fafc 100%);font-family:Inter,Arial,sans-serif;color:var(--text);padding:24px}
    .card{width:min(420px,100%);background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow);border-radius:28px;padding:28px}
    .logo{width:54px;height:54px;border-radius:18px;display:grid;place-items:center;background:linear-gradient(135deg,#4285f4,#34a853,#fbbc05,#ea4335);margin-bottom:18px;color:#fff;font-weight:900;font-size:22px}
    h1{font-size:24px;line-height:1.15;margin:0 0 8px}.sub{color:var(--muted);font-size:14px;line-height:1.45;margin-bottom:22px}
    label{display:block;font-size:13px;font-weight:800;margin:14px 0 7px} input,select{width:100%;height:46px;border:1px solid var(--line);border-radius:14px;padding:0 13px;font-size:15px;background:#fff;color:var(--text);outline:none} input:focus,select:focus{border-color:var(--blue);box-shadow:0 0 0 4px rgba(37,99,235,.12)}
    .row{display:flex;align-items:center;gap:8px;margin-top:14px;color:var(--muted);font-size:13px}.row input{width:auto;height:auto}
    button{width:100%;height:48px;border:0;border-radius:15px;background:var(--blue);color:#fff;font-weight:900;font-size:15px;cursor:pointer;margin-top:18px}button:hover{background:var(--blue2)}button:disabled{opacity:.7;cursor:not-allowed}
    .err{display:none;margin-top:14px;border:1px solid rgba(220,38,38,.22);background:rgba(220,38,38,.07);color:var(--red);padding:11px 12px;border-radius:14px;font-size:13px;line-height:1.35}.foot{margin-top:16px;color:var(--muted);font-size:12px;line-height:1.45}
  </style>
</head>
<body>
  <form class="card" id="form">
    <div class="logo">Z</div>
    <h1>Entrar no painel</h1>
    <div class="sub">Faça login uma vez e continue conectado neste navegador.</div>

    <label for="tenant">Painel</label>
    <select id="tenant" name="tenant">
      <option value="admin">Admin</option>
      <option value="panel">Painel</option>
      <option value="regina">Regina</option>
    </select>

    <label for="username">Usuário</label>
    <input id="username" name="username" autocomplete="username" required />

    <label for="password">Senha</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />

    <label class="row"><input id="remember" type="checkbox" checked /> Manter conectado por 30 dias</label>

    <button id="btn" type="submit">Entrar</button>
    <div id="err" class="err"></div>
    <div class="foot">Por segurança, a senha não é salva no navegador. O acesso fica salvo por cookie seguro e pode ser encerrado no botão “Sair”.</div>
  </form>
  <script>
    const qs = new URLSearchParams(location.search);
    const tenant = qs.get('tenant') || 'admin';
    const next = qs.get('next') || ('/' + tenant);
    const tenantEl = document.getElementById('tenant');
    const userEl = document.getElementById('username');
    const errEl = document.getElementById('err');
    tenantEl.value = ['admin','panel','regina'].includes(tenant) ? tenant : 'admin';
    userEl.value = localStorage.getItem('zape_login_user_' + tenantEl.value) || '';
    tenantEl.addEventListener('change', () => { userEl.value = localStorage.getItem('zape_login_user_' + tenantEl.value) || ''; });
    function showError(message){
      errEl.textContent = message || 'Não foi possível fazer login.';
      errEl.style.display = 'block';
    }

    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.style.display = 'none';
      const btn = document.getElementById('btn');
      btn.disabled = true; btn.textContent = 'Entrando...';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try{
        const body = {
          tenant: tenantEl.value,
          username: userEl.value.trim(),
          password: document.getElementById('password').value.trim(),
          remember: document.getElementById('remember').checked
        };
        const r = await fetch('/auth/login', {
          method:'POST',
          credentials:'same-origin',
          cache:'no-store',
          headers:{'Content-Type':'application/json','Accept':'application/json'},
          body: JSON.stringify(body),
          signal: controller.signal
        });

        const text = await r.text();
        let j = {};
        try { j = text ? JSON.parse(text) : {}; }
        catch(parseErr) {
          console.error('[ZAPE LOGIN] resposta não JSON:', r.status, text.slice(0, 300));
          throw new Error('O servidor respondeu de forma inesperada no login. Reinicie o PM2 e tente novamente.');
        }

        if(!r.ok || !j.ok) {
          console.warn('[ZAPE LOGIN] falhou:', { status: r.status, tenant: body.tenant, user: body.username, error: j.error });
          throw new Error(j.error || 'Usuário ou senha inválidos. Confira usuário e senha do .env para este painel.');
        }

        localStorage.setItem('zape_login_user_' + tenantEl.value, body.username);
        const target = (j.next && j.next.startsWith('/')) ? j.next : (next && next.startsWith('/') ? next : ('/' + tenantEl.value));
        location.assign(target);
      }catch(err){
        console.error('[ZAPE LOGIN] erro:', err);
        if (err && err.name === 'AbortError') showError('O login demorou demais para responder. Verifique se o servidor Node/PM2 está rodando corretamente.');
        else showError(err.message || String(err));
      }finally{
        clearTimeout(timer);
        btn.disabled = false; btn.textContent = 'Entrar';
      }
    });
  </script>
</body>
</html>`;
}

function registerAuthRoutes(app) {
  app.get("/login", (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(renderLoginPage());
  });

  app.post("/auth/login", (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    const tenantId = normalizeAuthValue(req.body?.tenant || "admin").toLowerCase();
    const username = normalizeAuthValue(req.body?.username || "");
    const password = normalizeAuthValue(req.body?.password || "");
    const remember = req.body?.remember !== false;

    const cfg = getTenantConfig(tenantId);
    if (!cfg) return res.status(400).json({ ok: false, error: "Painel inválido." });

    const check = checkCredentials(tenantId, username, password);
    logAuthAttempt(req, tenantId, username, check);

    if (!check.ok) {
      return res.status(401).json({
        ok: false,
        error: "Usuário ou senha inválidos. Confira se o usuário e a senha são exatamente os do .env para este painel.",
      });
    }

    const days = remember ? 30 : 1;
    const token = createToken({ tenantId, username: username || tenantId, days });
    setAuthCookie(res, req, tenantId, token, days);
    res.json({ ok: true, tenantId, next: cfg.path });
  });

  app.post("/auth/logout", (req, res) => {
    const tenantId = String(req.body?.tenant || req.query?.tenant || "").toLowerCase();
    if (tenantId && getTenantConfig(tenantId)) {
      clearAuthCookie(res, req, tenantId);
    } else {
      Object.keys(TENANT_CONFIGS).forEach((id) => clearAuthCookie(res, req, id));
    }
    res.json({ ok: true });
  });
}

module.exports = { makeBasicAuth, anyTenantAuth, registerAuthRoutes };
