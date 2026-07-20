'use strict';

var APP_RUNTIME = window.zapeAppConfig;
    if (!APP_RUNTIME) throw new Error('Configuração do painel não foi carregada.');
    var APP_TENANT = APP_RUNTIME.tenantId;
    var APP_CONFIG = APP_RUNTIME.active;
    var API_BASE = APP_CONFIG.apiBase;

    function getDefaultCloudLanguage(){
      return APP_RUNTIME.cloudLanguage;
    }

    function applyTenantCloudDefaults(){
      var lang = getDefaultCloudLanguage();
      ["cloudLanguage", "cloudTemplateLanguage", "cloudLibraryPremiumLanguage"].forEach(function(id){
        var el = document.getElementById(id);
        if (el && (!el.value || el.value === "pt_BR" || (APP_TENANT === "portugal" && id === "cloudLanguage"))) el.value = lang;
      });
      var sendLang = document.getElementById("cloudLanguage");
      if (sendLang && APP_TENANT === "portugal") sendLang.placeholder = "pt_PT";
      var tplLang = document.getElementById("cloudTemplateLanguage");
      if (tplLang && APP_TENANT === "portugal") tplLang.placeholder = "pt_PT";
    }

    document.title = APP_CONFIG.title;
    var brandTitle = document.querySelector(".brandText h1");
    if (brandTitle) brandTitle.textContent = APP_CONFIG.label;

    async function appLogout(){
      try{
        await window.zapeApi.request("/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenant: APP_TENANT })
        });
      }catch(e){}
      location.href = "/login?tenant=" + encodeURIComponent(APP_TENANT) + "&next=" + encodeURIComponent(location.pathname || ("/" + APP_TENANT));
    }

    document.getElementById("btnLogout")?.addEventListener("click", appLogout);

    /* ---------- helpers ---------- */
    function escapeHtml(s) {
      return String(s == null ? "" : s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function safeCssColor(value, fallback) {
      var raw = String(value == null ? "" : value).trim();
      var safeFallback = String(fallback || "#64748b");
      if (/^#[0-9a-f]{3,8}$/i.test(raw)) return raw;
      if (/^(?:rgb|hsl)a?\(\s*[0-9.%+\-,\s]+\)$/i.test(raw)) return raw;
      if (/^[a-z]{3,20}$/i.test(raw)) return raw;
      return safeFallback;
    }

    function setSafeElementUrl(element, attribute, value, options) {
      return Boolean(window.zapeSecurity && window.zapeSecurity.setElementUrl(element, attribute, value, options || {}));
    }

    function safeUrlForMarkup(value, options) {
      if (!window.zapeSecurity) return "";
      return escapeHtml(window.zapeSecurity.normalizeUrl(value, options || {}));
    }


    function leadStatusValue(lead){
      var st = "";
      try { st = inferStatus(lead); } catch(_) { st = String((lead && lead.leadStatus) ? lead.leadStatus : ""); }
      return st || "none";
    }

    function leadStatusClass(lead){
      return "status-" + leadStatusValue(lead);
    }

    function leadStatusLabel(lead){
      var st = leadStatusValue(lead);
      var map = {
        replied: "Respondeu",
        delivered: "Recebeu",
        pending: "Pendente",
        notDelivered: "Não recebeu",
        notExists: "Não existe",
        none: "Sem envio"
      };
      return map[st] || "Sem envio";
    }


    function iconMarkup(name, alt, cls){
      var extra = cls ? (' ' + String(cls).replace(/[^a-z0-9_-]/gi, '')) : '';
      var safeName = /^[a-z0-9_-]+$/i.test(String(name || '')) ? String(name) : 'info';
      return '<img class="uiIcon' + extra + '" src="/assets/ui-icons/' + safeName + '.svg" alt="' + escapeHtml(alt || '') + '">';
    }

    function statusFilterLabel(value){
      var map = {
        replied: "Responderam",
        delivered: "Receberam",
        notDelivered: "Não receberam",
        notExists: "Não existem"
      };
      return map[value || ""] || "Todos";
    }

    function toast(type, title, msg, ms) {
      if (ms == null) ms = 2800;

      var wrap = document.getElementById("toastWrap");
      var t = document.createElement("div");
      t.className = "toast";

      var color = (type === "ok") ? "var(--g-green)" : (type === "warn") ? "var(--g-yellow)" : "var(--g-red)";

      t.innerHTML =
        '<div class="tDot" style="background:' + color + '"></div>' +
        '<div>' +
          '<div class="tTitle">' + escapeHtml(title || "Aviso") + '</div>' +
          '<div class="tMsg">' + escapeHtml(msg || "") + '</div>' +
        '</div>' +
        '<button class="tClose" aria-label="Fechar">' + iconMarkup('close', 'Fechar') + '</button>';

      var closeBtn = t.querySelector(".tClose");
      if (closeBtn) closeBtn.addEventListener("click", function(){ t.remove(); });

      wrap.appendChild(t);
      setTimeout(function(){ if (t.isConnected) t.remove(); }, ms);
    }


    function ensureAppDialog(){
      var existing = document.getElementById("appDialogOverlay");
      if (existing) return existing;
      var ov = document.createElement("div");
      ov.id = "appDialogOverlay";
      ov.className = "appDialogOverlay";
      ov.setAttribute("role", "dialog");
      ov.setAttribute("aria-modal", "true");
      ov.setAttribute("aria-hidden", "true");
      document.body.appendChild(ov);
      return ov;
    }

    function closeAppDialog(resolve, value){
      var ov = document.getElementById("appDialogOverlay");
      if (ov){
        ov.classList.remove("open");
        ov.setAttribute("aria-hidden", "true");
        ov.innerHTML = "";
      }
      document.removeEventListener("keydown", closeAppDialog._handler || function(){});
      if (typeof resolve === "function") resolve(value);
    }

    function appDialogBase(opts){
      opts = opts || {};
      var ov = ensureAppDialog();
      return new Promise(function(resolve){
        var tone = opts.tone || "default";
        var iconClass = tone === "danger" ? "danger" : (tone === "warn" ? "warn" : "");
        var icon = opts.icon || (tone === "danger" ? "ph-trash" : (tone === "warn" ? "ph-warning-circle" : "ph-question"));
        var title = opts.title || "Confirmação";
        var message = opts.message || "";
        var inputHtml = opts.mode === "prompt" ? '<input class="appDialogInput" id="appDialogInput" type="text" autocomplete="off" />' : "";
        var choicesHtml = "";
        if (opts.mode === "choice"){
          choicesHtml = '<div class="appChoiceList">' + (opts.choices || []).map(function(c){
            return '<button class="appChoiceBtn" type="button" data-value="' + escapeHtml(c.value) + '"><span>' + escapeHtml(c.label) + '</span><i class="ph ph-caret-right"></i></button>';
          }).join("") + '</div>';
        }
        ov.innerHTML =
          '<div class="appDialogBox">' +
            '<div class="appDialogHead">' +
              '<div class="appDialogIcon ' + iconClass + '"><i class="ph ' + icon + '"></i></div>' +
              '<div style="min-width:0;">' +
                '<h3 class="appDialogTitle">' + escapeHtml(title) + '</h3>' +
                (message ? '<div class="appDialogText">' + escapeHtml(message) + '</div>' : '') +
              '</div>' +
            '</div>' +
            (inputHtml || choicesHtml ? '<div class="appDialogBody">' + inputHtml + choicesHtml + '</div>' : '') +
            '<div class="appDialogActions">' +
              '<button class="btn btnGhost" type="button" data-action="cancel">' + escapeHtml(opts.cancelText || "Cancelar") + '</button>' +
              (opts.mode === "choice" ? '' : '<button class="btn ' + (tone === "danger" ? "dangerGhost" : "btnPrimary") + '" type="button" data-action="ok">' + escapeHtml(opts.okText || "Confirmar") + '</button>') +
            '</div>' +
          '</div>';
        ov.classList.add("open");
        ov.setAttribute("aria-hidden", "false");

        var input = ov.querySelector("#appDialogInput");
        if (input){
          input.value = opts.defaultValue || "";
          setTimeout(function(){ input.focus(); input.select(); }, 40);
        } else {
          var okBtn = ov.querySelector('[data-action="ok"]') || ov.querySelector('.appChoiceBtn') || ov.querySelector('[data-action="cancel"]');
          if (okBtn) setTimeout(function(){ okBtn.focus(); }, 40);
        }

        function done(value){
          document.removeEventListener("keydown", onKey);
          ov.classList.remove("open");
          ov.setAttribute("aria-hidden", "true");
          ov.innerHTML = "";
          resolve(value);
        }
        function onKey(e){
          if (e.key === "Escape") done(null);
          if (e.key === "Enter" && opts.mode === "prompt") done(input ? input.value : "");
          if (e.key === "Enter" && opts.mode === "confirm") done(true);
        }
        document.addEventListener("keydown", onKey);

        ov.querySelector('[data-action="cancel"]')?.addEventListener("click", function(){ done(null); });
        ov.querySelector('[data-action="ok"]')?.addEventListener("click", function(){
          if (opts.mode === "prompt") return done(input ? input.value : "");
          return done(true);
        });
        ov.querySelectorAll(".appChoiceBtn").forEach(function(btn){
          btn.addEventListener("click", function(){ done(btn.getAttribute("data-value")); });
        });
      });
    }

    function uiConfirm(title, message, opts){
      opts = opts || {};
      return appDialogBase({
        mode: "confirm",
        title: title || "Confirmar ação",
        message: message || "",
        tone: opts.tone || "default",
        icon: opts.icon,
        okText: opts.okText || "Confirmar",
        cancelText: opts.cancelText || "Cancelar"
      }).then(function(v){ return v === true; });
    }

    function uiPrompt(title, message, defaultValue, opts){
      opts = opts || {};
      return appDialogBase({
        mode: "prompt",
        title: title || "Digite a informação",
        message: message || "",
        defaultValue: defaultValue || "",
        tone: opts.tone || "default",
        icon: opts.icon || "ph-pencil-simple",
        okText: opts.okText || "Salvar",
        cancelText: opts.cancelText || "Cancelar"
      });
    }

    function uiChoice(title, message, choices, opts){
      opts = opts || {};
      return appDialogBase({
        mode: "choice",
        title: title || "Escolha uma opção",
        message: message || "",
        choices: choices || [],
        tone: opts.tone || "default",
        icon: opts.icon || "ph-list"
      });
    }

    function setStatusDot(kind) {
      var dot = document.getElementById("dot");
      dot.className = "dot";
      if (kind === "ok") dot.classList.add("ok");
      if (kind === "warn") dot.classList.add("warn");
      if (kind === "err") dot.classList.add("err");
    }

    function anyOverlayOpen(){
      var ovs = document.querySelectorAll(".overlay");
      for (var i=0;i<ovs.length;i++){
        if (ovs[i].style.display === "flex") return true;
      }
      return false;
    }

    function openOverlay(id){
      var el = document.getElementById(id);
      if (el){
        el.style.display = "flex";
        document.body.classList.add("noScroll");
      }
    }
    function closeOverlay(id){
      var el = document.getElementById(id);
      if (el) el.style.display = "none";
      if (!anyOverlayOpen()) document.body.classList.remove("noScroll");
    }

    function wireOverlayClose(overlayId, closeBtnId){
      var ov = document.getElementById(overlayId);
      var btn = document.getElementById(closeBtnId);
      if (btn) btn.addEventListener("click", function(){ closeOverlay(overlayId); });
      if (ov) ov.addEventListener("click", function(e){ if (e.target === ov) closeOverlay(overlayId); });
    }

    wireOverlayClose("ovLead", "btnCloseLead");
    wireOverlayClose("ovInsightDdd", "btnCloseInsightDdd");
    wireOverlayClose("ovChatRegister", "btnCloseChatRegister");
    wireOverlayClose("ovQr", "btnCloseQr");
    wireOverlayClose("ovTags", "btnCloseTags");
    wireOverlayClose("ovFilters", "btnCloseFilters");

    /* ---------- Tags Drawer (menu) ---------- */
    (function(){
      var ov = document.getElementById("ovTagDrawer");
      var btn = document.getElementById("btnCloseTagDrawer");
      if (btn) btn.addEventListener("click", function(){ closeTagDrawer(); navTags.classList.remove("active"); });
      if (ov) ov.addEventListener("click", function(e){ if (e.target === ov){ closeTagDrawer(); navTags.classList.remove("active"); } });
    })();


    window.addEventListener("keydown", function(e){
      if (e.key === "Escape"){
        closeOverlay("ovLead");
        closeOverlay("ovChatRegister");
        closeOverlay("ovQr");
        closeOverlay("ovTags");
        closeOverlay("ovFilters");
        if (typeof closeTagDrawer === "function") closeTagDrawer();
      }
    });

    /* "/" foca busca */
    window.addEventListener("keydown", function(e){
      var active = document.activeElement;
      var tag = active ? active.tagName : "";
      var typing = tag === "INPUT" || tag === "TEXTAREA" || (active && active.isContentEditable);
      if (!typing && e.key === "/"){
        e.preventDefault();
        var q = document.getElementById("q");
        if (q) q.focus();
      }
    });

    function formatDate(iso){
      var d = new Date(iso);
      if (isNaN(d)) return String(iso || "");
      return d.toLocaleString("pt-BR");
    }

    /* +DDI número. Aceita Brasil e Portugal sem quebrar os números antigos. */
    function normalizePhoneDigitsClient(raw){
      var d = String(raw || "").replace(/\D+/g, "").replace(/^0+/, "");
      if (!d) return "";
      if (d.indexOf("55") === 0 && /^55\d{10,11}$/.test(d)) return d;
      if ((d.length === 10 || d.length === 11) && d.indexOf("55") !== 0) return "55" + d;
      if (d.indexOf("351") === 0 && /^351[2-9]\d{8}$/.test(d)) return d;
      if (/^[2-9]\d{8}$/.test(d)) return "351" + d;
      return d;
    }

    function phoneSearchVariantsClient(raw){
      var original = String(raw || "").replace(/\D+/g, "").replace(/^0+/, "");
      var normalized = normalizePhoneDigitsClient(raw);
      var set = {};
      [original, normalized].forEach(function(d){ if (d) set[d] = true; });
      Object.keys(set).forEach(function(d){
        if (d.indexOf("55") === 0) set[d.slice(2)] = true;
        if (d.indexOf("351") === 0) set[d.slice(3)] = true;
      });
      return Object.keys(set).filter(Boolean);
    }

    function formatWhatsAppPretty(raw){
      var digits = normalizePhoneDigitsClient(raw);
      if (!digits) return "—";

      if (digits.indexOf("55") === 0 && (digits.length === 12 || digits.length === 13)) {
        return "+55 " + digits.slice(2,4) + " " + digits.slice(4);
      }

      if (digits.indexOf("351") === 0 && digits.length === 12) {
        return "+351 " + digits.slice(3,6) + " " + digits.slice(6,9) + " " + digits.slice(9);
      }

      return "+" + digits;
    }

    function getDDDFromLead(lead){
      var digits = normalizePhoneDigitsClient(lead && (lead.whatsapp_digits || lead.whatsapp_raw || ""));
      if (!digits) return "";
      if (digits.indexOf("55") === 0 && (digits.length === 12 || digits.length === 13)) return digits.slice(2,4);
      if (digits.indexOf("351") === 0 && digits.length === 12) return digits.slice(3,5);
      return "";
    }

    function phoneMatchesSearchClient(lead, query){
      var queryVariants = phoneSearchVariantsClient(query);
      if (!queryVariants.length) return false;

      var candidateMap = {};
      [lead && lead.whatsapp_raw, lead && lead.whatsapp_digits, lead && lead.whatsapp, lead && lead.phone, lead && lead.telefone].forEach(function(value){
        phoneSearchVariantsClient(value).forEach(function(v){ candidateMap[v] = true; });
      });

      var candidates = Object.keys(candidateMap);
      for (var i=0;i<candidates.length;i++){
        for (var j=0;j<queryVariants.length;j++){
          if (candidates[i].indexOf(queryVariants[j]) !== -1 || queryVariants[j].indexOf(candidates[i]) !== -1) return true;
        }
      }

      return false;
    }

    var STATUS_FILTER_TIMEOUT_MIN = 30;

    function parseDateMs(value){
      if (!value) return null;
      var t = new Date(value).getTime();
      return isNaN(t) ? null : t;
    }

    /* Status sempre prioriza o backend. O fallback abaixo só existe para dados antigos. */
    function inferStatus(lead){
      if (lead && lead.leadStatus) return String(lead.leadStatus || "");

      var ms = lead.messageStatus || lead.msgStatus || lead.waStatus || lead.status || null;

      if (lead.notOnWhatsapp === true) return "notExists";
      if (ms && ms.notOnWhatsapp === true) return "notExists";
      if (ms && ms.isRegistered === false) return "notExists";
      if (lead.isRegisteredUser === false) return "notExists";

      var lastSendAt = (ms && ms.lastSendAt) || lead.lastSendAt || null;
      var hasOutbound = !!(lastSendAt || (ms && (ms.messageId || ms.lastMessageId || ms.sendError)) || lead.messageId);
      if (!hasOutbound) return "";

      var repliedAt = (ms && ms.repliedAt) || lead.repliedAt || null;
      var sendTs = parseDateMs(lastSendAt);
      var replyTs = parseDateMs(repliedAt);
      if (repliedAt && (!sendTs || (replyTs && replyTs + 5000 >= sendTs))) return "replied";

      var ack = null;
      if (typeof lead.ack === "number") ack = lead.ack;
      if (ms && typeof ms.ack === "number") ack = ms.ack;
      if (ms && typeof ms.lastAck === "number") ack = ms.lastAck;

      if (ack != null){
        if (ack >= 2) return "delivered";
        if (ack < 0) return "notDelivered";
      }

      if ((ms && ms.sendError) || lead.sendError) return "notDelivered";

      if (sendTs){
        var timeout = STATUS_FILTER_TIMEOUT_MIN * 60 * 1000;
        if (Date.now() - sendTs >= timeout) return "notDelivered";
        return "pending";
      }

      return "";
    }

    /* ---------- State ---------- */
    var cachedTags = [];
    var itemsAll = [];
    var filteredItems = [];
    var filteredTotal = 0;

    var pageSizeEl = document.getElementById("pageSize");
    var btnPrev = document.getElementById("btnPrev");
    var btnNext = document.getElementById("btnNext");
    var pageInfo = document.getElementById("pageInfo");
    var tbody = document.getElementById("tbody");
    var lastSync = document.getElementById("lastSync");

    var pageSize = Number(pageSizeEl.value || 200);
    var pageIndex = 0;
    var leadPageMeta = { page: 1, pageSize: pageSize, totalPages: 1, hasNext: false, hasPrev: false };

    /* ---------- WhatsApp ---------- */
    var btnInit = document.getElementById("btnInit");
    var btnOpenQr = document.getElementById("btnOpenQr");
    var btnRemoveWaAuth = document.getElementById("btnRemoveWaAuth");
    var waStatus = document.getElementById("waStatus");
    var waMeta = document.getElementById("waMeta");

    var kpiReplied = document.getElementById("kpiReplied");
    var kpiDeliveredNoReply = document.getElementById("kpiDeliveredNoReply");
    var kpiNotDelivered = document.getElementById("kpiNotDelivered");
    var kpiNotOnWhatsapp = document.getElementById("kpiNotOnWhatsapp");
    var kpiMeta = document.getElementById("kpiMeta");

    function whatsappStatusLabel(status, enabled){
      if (!enabled) return "Desativado";
      var map = {
        connected: "Conectado",
        authenticated: "Autenticado",
        ready: "Conectado",
        qr: "Aguardando QR Code",
        starting: "Iniciando conexão",
        initializing: "Iniciando conexão",
        disconnected: "Desconectado",
        error: "Erro na conexão",
        loading: "Carregando"
      };
      return map[String(status || "").toLowerCase()] || (status ? String(status) : "Verificando");
    }

    function setWaStatusCard(kind){
      var card = document.getElementById("waStatusCard");
      if (!card) return;
      card.classList.remove("status-ok", "status-warn", "status-err");
      card.classList.add(kind === "ok" ? "status-ok" : kind === "err" ? "status-err" : "status-warn");
    }

    async function refreshWhatsApp(){
      var st = await fetch(API_BASE + "/whatsapp/status").then(function(r){ return r.json(); });

      waStatus.textContent = whatsappStatusLabel(st.status, st.enabled);
      var authState = st.authentication || {};
      var authHint = authState.accountMasked ? ("Conta " + authState.accountMasked) : "";
      waMeta.textContent = st.lastError ? ("Problema: " + st.lastError) : (authHint || (st.enabled ? "Sessão monitorada pelo painel" : "Ative a conexão para enviar mensagens"));

      if (btnRemoveWaAuth){
        btnRemoveWaAuth.style.display = authState.canRemove ? "inline-flex" : "none";
        btnRemoveWaAuth.disabled = false;
      }
      if (btnInit){
        btnInit.disabled = !st.enabled || authState.canConnect === false;
        btnInit.title = authState.exists ? "Remova a autenticação anterior antes de conectar outro número." : "Conectar WhatsApp Web";
      }

      if (!st.enabled) { setStatusDot("err"); setWaStatusCard("err"); }
      else if (st.status === "connected" || st.status === "authenticated" || st.status === "ready") { setStatusDot("ok"); setWaStatusCard("ok"); }
      else if (st.status === "qr" || st.status === "starting" || st.status === "initializing") { setStatusDot("warn"); setWaStatusCard("warn"); }
      else if (st.status === "error" || st.status === "disconnected") { setStatusDot("err"); setWaStatusCard("err"); }
      else { setStatusDot("warn"); setWaStatusCard("warn"); }

      var qr = await fetch(API_BASE + "/whatsapp/qr").then(function(r){ return r.json(); });
      btnOpenQr.disabled = !(qr && qr.qr);
      if (qr && qr.qr){
        setSafeElementUrl(document.getElementById("qrBig"), "src", qr.qr, { allowDataImage: true });
      }
    }

    async function refreshStats(){
      var s = await fetch(API_BASE + "/whatsapp/stats?notDeliveredAfterMin=30")
        .then(function(r){ return r.json(); })
        .catch(function(){ return null; });
      if (!s || !s.ok) return;

      kpiReplied.textContent = (s.replied == null) ? 0 : s.replied;
      kpiDeliveredNoReply.textContent = (s.deliveredNoReply == null) ? 0 : s.deliveredNoReply;
      kpiNotDelivered.textContent = (s.notDelivered == null) ? 0 : s.notDelivered;
      kpiNotOnWhatsapp.textContent = (s.notOnWhatsapp == null) ? 0 : s.notOnWhatsapp;

      kpiMeta.textContent = "Resultados do WhatsApp";
    }

    btnInit.addEventListener("click", async function(){
      btnInit.disabled = true;
      btnInit.textContent = "Conectando...";
      try{
        var r = await fetch(API_BASE + "/whatsapp/init", { method: "POST" });
        var j = {};
        try{ j = await r.json(); }catch{}
        if (!r.ok) throw new Error(j.error || "Falha ao conectar");

        toast("ok", "WhatsApp", "Pronto. Abra o QR e escaneie.");
        await refreshWhatsApp();
        openOverlay("ovQr");
      }catch(e){
        toast("err", "WhatsApp", e.message || "Erro");
      }finally{
        btnInit.textContent = "Conectar";
        try{ await refreshWhatsApp(); }catch(e){}
      }
    });

    if (btnRemoveWaAuth) btnRemoveWaAuth.addEventListener("click", async function(){
      var expected = "REMOVER " + String(APP_TENANT || "").toUpperCase();
      var typed = window.prompt("Esta ação desconecta o WhatsApp e apaga somente a autenticação deste painel. Digite exatamente: " + expected);
      if (typed === null) return;
      if (String(typed).trim().toUpperCase() !== expected){
        toast("warn", "Autenticação", "Confirmação incorreta. Nada foi removido.");
        return;
      }
      btnRemoveWaAuth.disabled = true;
      try{
        var r = await fetch(API_BASE + "/whatsapp/authentication", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: typed })
        });
        var j = await r.json().catch(function(){ return {}; });
        if (!r.ok) throw new Error(j.error || "Falha ao remover autenticação");
        toast("ok", "Autenticação removida", "Agora é possível conectar outro número com um QR Code novo.");
      }catch(e){
        toast("err", "Autenticação", e.message || "Falha ao remover autenticação.");
      }finally{
        await refreshWhatsApp().catch(function(){});
      }
    });

    btnOpenQr.addEventListener("click", async function(){
      try{
        var qr = await fetch(API_BASE + "/whatsapp/qr").then(function(r){ return r.json(); });
        if (qr && qr.qr){
          setSafeElementUrl(document.getElementById("qrBig"), "src", qr.qr, { allowDataImage: true });
          openOverlay("ovQr");
        } else {
          toast("warn", "QR Code", "Ainda não há QR. Clique em Conectar primeiro.");
        }
      }catch{
        toast("err", "QR Code", "Falha ao carregar o QR.");
      }
    });

    /* ---------- Tags ---------- */
    async function fetchTags(){
      var r = await fetch(API_BASE + "/tags");
      var j = await r.json();
      cachedTags = (j && j.ok && Array.isArray(j.items)) ? j.items : [];
      renderTagsSidebar();
      renderTagsFilterPicker();
      document.getElementById("navTagsCount").textContent = String(cachedTags.length || 0);
    }

    function renderTags(tagsFull){
      var arr = Array.isArray(tagsFull) ? tagsFull : [];
      if (!arr.length) return '<span class="hint">—</span>';

      var out = "";
      for (var i=0;i<arr.length;i++){
        var t = arr[i] || {};
        var name = escapeHtml(t.name || "");
        var color = safeCssColor(t.color, "#111827");
        out += '<span class="tagPill"><span class="tagDot" style="background:' + color + '"></span>' + name + '</span>';
      }
      return out;
    }

    
    var editingTagId = null;

    function renderTagsSidebar(){
      var box = document.getElementById("tagsList");
      if (!box) return;

      if (!cachedTags.length){
        box.innerHTML = '<div class="hint" style="margin-top:10px;">Nenhuma tag criada ainda.</div>';
        return;
      }

      var html = "";
      for (var i=0;i<cachedTags.length;i++){
        var t = cachedTags[i] || {};
        var id = escapeHtml(t.id);
        var name = escapeHtml(t.name || "");
        var color = safeCssColor(t.color, "#111827");

        if (editingTagId === t.id){
          html +=
            '<div class="tagRow" data-tag-id="' + id + '">' +
              '<div class="tagTop">' +
                '<div class="tagLeft">' +
                  '<span class="tagDot" style="background:' + color + '"></span>' +
                  '<div class="tagName" title="' + name + '">' + name + '</div>' +
                '</div>' +
                '<div class="tagActions">' +
                  '<button class="iconMini" type="button" data-action="cancelEdit" title="Cancelar">' + iconMarkup('undo','Cancelar') + '</button>' +
                  '<button class="iconMini" type="button" data-action="saveEdit" title="Salvar">' + iconMarkup('check','Salvar') + '</button>' +
                '</div>' +
              '</div>' +
              '<div class="tagEdit">' +
                '<input class="input" data-field="name" value="' + name + '" placeholder="Nome da tag" style="flex:1 1 160px; min-width:160px;" />' +
                '<input class="input tagColor" data-field="color" type="color" value="' + color + '" />' +
              '</div>' +
            '</div>';
        } else {
          html +=
            '<div class="tagRow" data-tag-id="' + id + '">' +
              '<div class="tagTop">' +
                '<div class="tagLeft">' +
                  '<span class="tagDot" style="background:' + color + '"></span>' +
                  '<div class="tagName" title="' + name + '">' + name + '</div>' +
                '</div>' +
                '<div class="tagActions">' +
                  '<button class="iconMini" type="button" data-action="edit" title="Editar">' + iconMarkup('edit','Editar') + '</button>' +
                  '<button class="iconMini iconDanger" type="button" data-action="delete" title="Deletar">' + iconMarkup('trash','Deletar') + '</button>' +
                '</div>' +
              '</div>' +
            '</div>';
        }
      }
      box.innerHTML = html;
    }

    // delegação de eventos (lista de tags)
    (function(){
      var box = document.getElementById("tagsList");
      if (!box) return;

      box.addEventListener("click", async function(e){
        var btn = e.target && e.target.closest ? e.target.closest("[data-action]") : null;
        if (!btn) return;

        var row = btn.closest("[data-tag-id]");
        if (!row) return;

        var tagId = row.getAttribute("data-tag-id");
        var action = btn.getAttribute("data-action");

        var tag = cachedTags.find(function(x){ return String(x.id) === String(tagId); }) || null;

        if (action === "edit"){
          editingTagId = tagId;
          renderTagsSidebar();
          return;
        }

        if (action === "cancelEdit"){
          editingTagId = null;
          renderTagsSidebar();
          return;
        }

        if (action === "saveEdit"){
          var nameEl = row.querySelector('[data-field="name"]');
          var colorEl = row.querySelector('[data-field="color"]');

          var name = (nameEl ? nameEl.value : "").trim();
          var color = (colorEl ? colorEl.value : (tag ? tag.color : "#111827"));

          if (!name){ toast("warn", "Tag", "Digite um nome."); return; }

          btn.disabled = true;
          try{
            var r = await fetch(API_BASE + "/tags", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: tagId, name: name, color: color })
            });
            var j = await r.json();
            if (!r.ok) throw new Error(j.error || "Erro ao salvar tag");

            toast("ok", "Tag", "Atualizada.");
            editingTagId = null;
            await fetchTags();
            await loadLeads(false);
          }catch(err){
            toast("err", "Tag", err.message || "Erro");
          }finally{
            btn.disabled = false;
          }
          return;
        }

        if (action === "delete"){
          if (!tag) return;
          var ok = await uiConfirm("Deletar tag?", 'A tag "' + (tag.name || "") + '" será removida de todos os leads.', { tone: "danger", okText: "Deletar tag", icon: "ph-trash" });
          if (!ok) return;

          btn.disabled = true;
          try{
            var r = await fetch(API_BASE + "/tags/" + encodeURIComponent(tagId), { method: "DELETE" });
            var j = {};
            try{ j = await r.json(); }catch{}
            if (!r.ok) throw new Error(j.error || "Erro ao deletar tag");

            toast("ok", "Tag", "Deletada.");
            editingTagId = null;
            await fetchTags();
            await loadLeads(false);
          }catch(err){
            toast("err", "Tag", err.message || "Erro");
          }finally{
            btn.disabled = false;
          }
        }
      });
    })();


    function renderTagsFilterPicker(){
      var el = document.getElementById("fTags");
      if (!el) return;

      if (!cachedTags.length){
        el.innerHTML = '<div class="hint">Crie tags no menu para aparecer aqui.</div>';
        return;
      }

      var html = "";
      for (var i=0;i<cachedTags.length;i++){
        var t = cachedTags[i];
        var id = escapeHtml(t.id);
        var name = escapeHtml(t.name);
        var color = safeCssColor(t.color, "#111827");

        html +=
          '<label>' +
            '<input type="checkbox" value="' + id + '">' +
            '<span class="tagDot" style="background:' + color + '"></span>' +
            '<span>' + name + '</span>' +
          '</label>';
      }
      el.innerHTML = html;
    }

    /* ---------- Lead details ---------- */
    var leadTitle = document.getElementById("leadTitle");
    var leadDetails = document.getElementById("leadDetails");

    function detailBox(k, v){
      return (
        '<div class="detailItem">' +
          '<div class="k">' + escapeHtml(k) + '</div>' +
          '<div class="v">' + escapeHtml(v) + '</div>' +
        '</div>'
      );
    }

    var currentLeadForEdit = null;

    function setLeadEditValue(id, value){
      var el = document.getElementById(id);
      if (el) el.value = value == null ? '' : String(value);
    }

    function openLeadDetails(lead){
      if (!lead) return;
      currentLeadForEdit = lead;
      leadTitle.textContent = lead.nome || "Detalhes do lead";
      setLeadEditValue('leadEditNome', lead.nome || '');
      setLeadEditValue('leadEditWhatsapp', lead.whatsapp_raw || lead.whatsapp_digits || '');
      setLeadEditValue('leadEditEmail', lead.email || '');
      setLeadEditValue('leadEditEmpresa', lead.empresa || '');
      setLeadEditValue('leadEditJaAnuncia', lead.jaAnuncia || '');
      setLeadEditValue('leadEditWebsite', lead.website || '');
      var meta = document.getElementById('leadEditMeta');
      if (meta) meta.textContent = 'Criado em ' + formatDate(lead.createdAt) + (lead.updatedAt ? (' • Atualizado em ' + formatDate(lead.updatedAt)) : '');
      openOverlay("ovLead");
    }

    function readLeadEditPayload(){
      return {
        _version: currentLeadForEdit && currentLeadForEdit._version || '',
        nome: String(document.getElementById('leadEditNome').value || '').trim(),
        whatsapp: String(document.getElementById('leadEditWhatsapp').value || '').trim(),
        email: String(document.getElementById('leadEditEmail').value || '').trim(),
        empresa: String(document.getElementById('leadEditEmpresa').value || '').trim(),
        jaAnuncia: String(document.getElementById('leadEditJaAnuncia').value || '').trim(),
        website: String(document.getElementById('leadEditWebsite').value || '').trim()
      };
    }

    async function saveLeadEdits(){
      if (!currentLeadForEdit || !currentLeadForEdit.id) return;
      var button = document.getElementById('btnSaveLead');
      var payload = readLeadEditPayload();
      if (!payload.nome){ toast('warn', 'Lead', 'Nome é obrigatório.'); return; }
      button.disabled = true;
      try {
        var response = await fetch(API_BASE + '/leads/' + encodeURIComponent(currentLeadForEdit.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        var json = await response.json().catch(function(){ return {}; });
        if (response.status === 409 && json.code === 'LEAD_PHONE_CONFLICT' && json.mergeAvailable){
          var mergeConfirmed = await uiConfirm(
            'WhatsApp já cadastrado',
            'Já existe outro lead com este número. O sistema não sobrescreveu nenhum cadastro. Deseja unir este lead ao cadastro existente, preservando tags e referências do CRM?',
            { tone: 'warn', okText: 'Unir leads', icon: 'ph-git-merge' }
          );
          if (!mergeConfirmed) throw new Error('Alteração cancelada porque o WhatsApp já pertence a outro lead.');
          var mergeResponse = await fetch(API_BASE + '/leads/' + encodeURIComponent(json.conflictLeadId) + '/merge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceLeadId: currentLeadForEdit.id,
              sourceVersion: currentLeadForEdit._version,
              targetVersion: json.conflictVersion,
              desiredPhone: payload.whatsapp,
              confirm: 'MERGE_LEADS'
            })
          });
          var mergeJson = await mergeResponse.json().catch(function(){ return {}; });
          if (!mergeResponse.ok || !mergeJson.ok) throw new Error(mergeJson.error || 'Não foi possível unir os leads.');
          toast('ok', 'Leads unidos', 'O cadastro duplicado foi consolidado de forma explícita.');
          closeOverlay('ovLead');
          currentLeadForEdit = null;
          await loadLeads(false);
          try { await crmLoad(); crmRender(); } catch(e) {}
          return;
        }
        if (!response.ok || !json.ok) throw new Error(json.error || 'Não foi possível salvar o lead.');
        currentLeadForEdit = json.lead;
        toast('ok', 'Lead atualizado', 'As alterações foram salvas e registradas no histórico.');
        closeOverlay('ovLead');
        await loadLeads(false);
        try { await crmLoad(); crmRender(); } catch(e) {}
      } catch (error) {
        toast('err', 'Lead', error.message || 'Não foi possível salvar as alterações.');
      } finally {
        button.disabled = false;
      }
    }

    var btnSaveLead = document.getElementById('btnSaveLead');
    if (btnSaveLead) btnSaveLead.addEventListener('click', saveLeadEdits);

    /* ---------- Edit tags (lead) ---------- */
    var tagsGrid = document.getElementById("tagsGrid");
    var tagsMeta = document.getElementById("tagsMeta");
    var btnCancelTags = document.getElementById("btnCancelTags");
    var btnSaveTags = document.getElementById("btnSaveTags");
    var currentLeadForTags = null;

    function openTagsEditor(lead){
      currentLeadForTags = lead;

      tagsMeta.textContent =
        (lead && lead.nome ? lead.nome : "") +
        (lead ? (" • " + formatWhatsAppPretty(lead.whatsapp_digits || lead.whatsapp_raw || "")) : "");

      var selected = new Set(Array.isArray(lead.tagIds) ? lead.tagIds : []);
      var html = "";

      for (var i=0;i<cachedTags.length;i++){
        var t = cachedTags[i] || {};
        var checked = selected.has(t.id) ? "checked" : "";
        var id = escapeHtml(t.id);
        var name = escapeHtml(t.name);
        var color = safeCssColor(t.color, "#111827");

        html +=
          '<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:16px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.80);user-select:none;cursor:pointer;font-weight:900;">' +
            '<input type="checkbox" value="' + id + '" ' + checked + ' />' +
            '<span class="tagDot" style="background:' + color + '"></span>' +
            '<span>' + name + '</span>' +
          '</label>';
      }

      tagsGrid.innerHTML = html;
      openOverlay("ovTags");
    }

    btnCancelTags.addEventListener("click", function(){ closeOverlay("ovTags"); });

    btnSaveTags.addEventListener("click", async function(){
      if (!currentLeadForTags) return;

      var inputs = tagsGrid.querySelectorAll('input[type="checkbox"]');
      var ids = [];
      for (var i=0;i<inputs.length;i++){
        if (inputs[i].checked) ids.push(inputs[i].value);
      }

      btnSaveTags.disabled = true;
      try{
        var url = API_BASE + "/leads/" + encodeURIComponent(currentLeadForTags.id) + "/tags";
        var r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tagIds: ids })
        });
        var j = await r.json();
        if (!r.ok) throw new Error(j.error || "Erro ao salvar tags");

        toast("ok", "Tags", "Salvas com sucesso.");
        closeOverlay("ovTags");
        await loadLeads(true);
      }catch(e){
        toast("err", "Tags", e.message || "Erro");
      }finally{
        btnSaveTags.disabled = false;
      }
    });

    /* ---------- Tag creation (sidebar) ---------- */
    var btnCreateTag = document.getElementById("btnCreateTag");
    var newTagName = document.getElementById("newTagName");
    var newTagColor = document.getElementById("newTagColor");

    btnCreateTag.addEventListener("click", async function(){
      var name = (newTagName.value || "").trim();
      var color = newTagColor.value;

      if (!name){ toast("warn", "Tag", "Digite um nome."); return; }

      btnCreateTag.disabled = true;
      try{
        var r = await fetch(API_BASE + "/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name, color: color })
        });
        var j = await r.json();
        if (!r.ok) throw new Error(j.error || "Erro ao criar tag");

        newTagName.value = "";
        toast("ok", "Tag", "Criada com sucesso.");
        await fetchTags();
        await loadLeads(false);
      }catch(e){
        toast("err", "Tag", e.message || "Erro");
      }finally{
        btnCreateTag.disabled = false;
      }
    });

    /* ---------- Filters overlay ---------- */
    var btnOpenFilters = document.getElementById("btnOpenFilters");
    var btnOpenFilters2 = document.getElementById("btnOpenFilters2");
    var btnApplyFilters = document.getElementById("btnApplyFilters");
    var btnClearFilters = document.getElementById("btnClearFilters");

    btnOpenFilters.addEventListener("click", function(){ syncFiltersUI(); openOverlay("ovFilters"); });
    btnOpenFilters2.addEventListener("click", function(){ syncFiltersUI(); openOverlay("ovFilters"); });

    var filters = {
      ddd: "",
      from: "",
      to: "",
      tagIds: [],
      status: ""
    };

    function syncFiltersUI(){
      document.getElementById("fDDD").value = filters.ddd || "";
      document.getElementById("fFrom").value = filters.from || "";
      document.getElementById("fTo").value = filters.to || "";

      var tagChecks = document.querySelectorAll('#fTags input[type="checkbox"]');
      for (var i=0;i<tagChecks.length;i++){
        tagChecks[i].checked = filters.tagIds.indexOf(tagChecks[i].value) !== -1;
      }

      var st = filters.status || "";
      var radio = document.querySelector('input[name="fStatus"][value="' + st.replace(/"/g,'') + '"]');
      if (radio) radio.checked = true;
      else {
        var all = document.querySelector('input[name="fStatus"][value=""]');
        if (all) all.checked = true;
      }
    }


    function readFiltersFromUI(){
      filters.ddd = (document.getElementById("fDDD").value || "").trim().replace(/\D+/g, "");
      filters.from = document.getElementById("fFrom").value || "";
      filters.to = document.getElementById("fTo").value || "";

      var tagChecks = document.querySelectorAll('#fTags input[type="checkbox"]');
      var ids = [];
      for (var i=0;i<tagChecks.length;i++){
        if (tagChecks[i].checked) ids.push(tagChecks[i].value);
      }
      filters.tagIds = ids;

      var st = document.querySelector('input[name="fStatus"]:checked');
      filters.status = st ? st.value : "";
    }

    function clearFiltersUI(){
      document.getElementById("fDDD").value = "";
      document.getElementById("fFrom").value = "";
      document.getElementById("fTo").value = "";
      var tagChecks = document.querySelectorAll('#fTags input[type="checkbox"]');
      for (var i=0;i<tagChecks.length;i++) tagChecks[i].checked = false;
      var all = document.querySelector('input[name="fStatus"][value=""]');
      if (all) all.checked = true;
    }

    function renderActiveFiltersSummary(){
      var el = document.getElementById("activeFilterSummary");
      if (!el) return;
      var chips = [];
      var q = (document.getElementById("q") && document.getElementById("q").value || "").trim();
      if (q) chips.push('<span class="filterChip">Busca: <strong>' + escapeHtml(q) + '</strong></span>');
      if (filters.status) chips.push('<span class="filterChip">Status: <strong>' + escapeHtml(statusFilterLabel(filters.status)) + '</strong></span>');
      if (filters.ddd) chips.push('<span class="filterChip">DDD: <strong>' + escapeHtml(filters.ddd) + '</strong></span>');
      if (filters.from || filters.to) chips.push('<span class="filterChip">Período: <strong>' + escapeHtml((filters.from || "início") + " até " + (filters.to || "hoje")) + '</strong></span>');
      if (filters.tagIds && filters.tagIds.length) chips.push('<span class="filterChip">Tags: <strong>' + filters.tagIds.length + '</strong></span>');
      el.innerHTML = chips.length ? chips.join("") : '<span class="filterChip">Sem filtros ativos</span>';
    }

    function applyFiltersToItems(){
      var q = (document.getElementById("q").value || "").trim().toLowerCase();
      var fromTs = filters.from ? new Date(filters.from + "T00:00:00").getTime() : null;
      var toTs = filters.to ? new Date(filters.to + "T23:59:59").getTime() : null;

      filteredItems = itemsAll.filter(function(lead){
        // busca
        if (q){
          var hay = String(lead.nome||"") + " " + String(lead.email||"") + " " + String(lead.empresa||"") + " " + String(lead.whatsapp_raw||"") + " " + String(lead.whatsapp_digits||"");
          if (hay.toLowerCase().indexOf(q) === -1 && !phoneMatchesSearchClient(lead, q)) return false;
        }

        // ddd
        if (filters.ddd){
          var ddd = getDDDFromLead(lead);
          if (ddd !== filters.ddd) return false;
        }

        // data
        if (fromTs != null || toTs != null){
          var t = new Date(lead.createdAt).getTime();
          if (isNaN(t)) return false;
          if (fromTs != null && t < fromTs) return false;
          if (toTs != null && t > toTs) return false;
        }

        // tags (qualquer uma)
        if (filters.tagIds && filters.tagIds.length){
          var leadTagIds = Array.isArray(lead.tagIds) ? lead.tagIds : [];
          var hasAny = false;
          for (var i=0;i<filters.tagIds.length;i++){
            if (leadTagIds.indexOf(filters.tagIds[i]) !== -1){ hasAny = true; break; }
          }
          if (!hasAny) return false;
        }

        // status
        if (filters.status){
          var st = inferStatus(lead);
          if (st !== filters.status) return false;
        }

        return true;
      });

      filteredTotal = filteredItems.length;
      document.getElementById("navLeadsCount").textContent = String(filteredTotal);
    }

    function syncQuickStatusCards(){
      document.querySelectorAll("[data-quick-status]").forEach(function(card){
        card.classList.toggle("is-active", (card.getAttribute("data-quick-status") || "") === (filters.status || ""));
      });
    }

    document.querySelectorAll("[data-quick-status]").forEach(function(card){
      function run(){
        filters.status = card.getAttribute("data-quick-status") || "";
        syncQuickStatusCards();
        loadLeads(true).catch(function(e){
          toast("err", "Filtro", e.message || "Falha ao aplicar filtro rápido.");
        });
      }
      card.addEventListener("click", run);
      card.addEventListener("keydown", function(e){
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run(); }
      });
    });

    btnApplyFilters.addEventListener("click", function(){
      readFiltersFromUI();
      syncQuickStatusCards();
      closeOverlay("ovFilters");
      if (typeof closeTagDrawer === "function") closeTagDrawer();
      loadLeads(true).then(function(){
        toast("ok", "Filtros", "Aplicados.");
      }).catch(function(e){
        toast("err", "Filtros", e.message || "Falha ao aplicar filtros.");
      });
    });

    btnClearFilters.addEventListener("click", function(){
      clearFiltersUI();
      readFiltersFromUI();
      syncQuickStatusCards();
      loadLeads(true).then(function(){
        toast("warn", "Filtros", "Limpos.");
      }).catch(function(e){
        toast("err", "Filtros", e.message || "Falha ao limpar filtros.");
      });
    });


    async function deleteLeadFromList(lead, buttonEl){
      if (!lead || !lead.id) return;

      var leadName = lead.nome || "Lead sem nome";
      var wa = formatWhatsAppPretty(lead.whatsapp_digits || lead.whatsapp_raw || "");
      var duplicateCount = Math.max(0, Number(lead.duplicateCount || 0));
      var duplicateMsg = duplicateCount > 0
        ? ("\n\nObservação: este WhatsApp tem " + duplicateCount + " cadastro(s) duplicado(s) oculto(s) na lista única. Esta ação remove apenas o cadastro exibido.")
        : "";
      var msg =
        "Deletar este lead?\n\n" +
        leadName + (wa && wa !== "—" ? ("\n" + wa) : "") +
        "\n\nA ação remove o lead da lista, das tags, do funil e limpa o status de teste do WhatsApp quando não houver outro lead com o mesmo número." +
        duplicateMsg;

      if (!(await uiConfirm("Deletar este lead?", msg, { tone: "danger", okText: "Deletar lead", icon: "ph-trash" }))) return;

      var originalText = buttonEl ? buttonEl.textContent : "";
      if (buttonEl){
        buttonEl.disabled = true;
        buttonEl.textContent = "...";
      }

      try{
        var url = API_BASE + "/leads/" + encodeURIComponent(lead.id) + "?clearWhatsappStatus=1";
        var res = await fetch(url, { method: "DELETE" });
        var json = {};
        try{ json = await res.json(); }catch{}
        if (!res.ok || !json.ok) throw new Error(json.error || "Falha ao deletar lead.");

        itemsAll = itemsAll.filter(function(x){ return String(x.id) !== String(lead.id); });
        filteredItems = filteredItems.filter(function(x){ return String(x.id) !== String(lead.id); });
        filteredTotal = Math.max(0, Number(filteredTotal || 0) - 1);
        document.getElementById("navLeadsCount").textContent = String(filteredTotal);
        renderPage();

        toast("ok", "Lead deletado", "Você já pode cadastrar o mesmo número novamente para testar.");

        try{ await refreshStats(); }catch{}
        try{ await loadLeads(false); }catch{}
      }catch(e){
        toast("err", "Erro ao deletar", e.message || "Não foi possível deletar este lead.");
        if (buttonEl){
          buttonEl.disabled = false;
          buttonEl.innerHTML = originalText || iconMarkup("trash", "Deletar");
        }
      }
    }

    /* ---------- Pagination + render ---------- */
    function setLoadingRows(){
      tbody.innerHTML =
        '<tr><td colspan="4" style="padding:14px;">' +
          '<div class="skeleton skRow"></div>' +
          '<div style="height:8px;"></div>' +
          '<div class="skeleton skRow w60"></div>' +
        '</td></tr>';
    }

    function renderPage(){
      var list = Array.isArray(filteredItems) ? filteredItems : itemsAll;
      var total = Number.isFinite(Number(filteredTotal)) ? Number(filteredTotal) : list.length;

      var totalPages = Math.max(1, Number(leadPageMeta.totalPages || Math.ceil(total / pageSize)));
      pageIndex = Math.max(0, Number(leadPageMeta.page || 1) - 1);
      var pageItems = list;

      tbody.innerHTML = "";

      if (!pageItems.length){
        tbody.innerHTML =
          '<tr><td colspan="4" style="padding:18px;">' +
            '<div style="font-weight:900; color:var(--txt);">Nenhum lead encontrado.</div>' +
            '<div class="hint" style="margin-top:4px;">Ajuste os filtros ou recarregue a lista.</div>' +
          '</td></tr>';
      }

      for (var i=0;i<pageItems.length;i++){
        var lead = pageItems[i];
        var tr = document.createElement("tr");

        var leadSub = [lead.empresa, lead.email].filter(Boolean).join(" • ");
        var duplicateCount = Math.max(0, Number(lead.duplicateCount || 0));
        var duplicateLabel = duplicateCount === 1 ? "1 duplicado oculto" : (duplicateCount + " duplicados ocultos");
        var duplicateHtml = duplicateCount > 0 ? ('<div class="duplicateNote">+' + escapeHtml(duplicateLabel) + '</div>') : '';
        var leadCellHtml =
          '<div class="leadCell">' +
            '<button class="avatarBtn ' + leadStatusClass(lead) + '" type="button" aria-label="Ver detalhes" data-avatar="' + escapeHtml(lead.id) + '"></button>' +
            '<div class="leadName">' +
              '<div class="n">' + escapeHtml(lead.nome || "—") + '</div>' +
              '<div class="s">' + escapeHtml(leadSub || "Sem empresa/e-mail informado") + '</div>' +
              duplicateHtml +
            '</div>' +
          '</div>';

        var waTxt = escapeHtml(formatWhatsAppPretty(lead.whatsapp_digits || lead.whatsapp_raw || "—"));
        var stVal = leadStatusValue(lead);
        var waCellHtml = '<div class="phoneStack"><div>' + waTxt + '</div><span class="statusBadge status-' + escapeHtml(stVal) + '">' + escapeHtml(leadStatusLabel(lead)) + '</span></div>';
        var tagsHtml = renderTags(lead.tagsFull);

        var actionsHtml =
          '<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">' +
            '<button class="btn btnSoft" type="button" data-lead-chat="' + escapeHtml(lead.id) + '" style="padding:10px 12px;"><i class="ph ph-chat-circle-text"></i> Conversar</button>' +
            '<button class="btn btnGhost" type="button" data-tags="' + escapeHtml(lead.id) + '" style="padding:10px 12px;"><i class="ph ph-tag"></i> Tags</button>' +
            '<button class="iconMini iconDanger" type="button" data-delete-lead="' + escapeHtml(lead.id) + '" title="Deletar lead" aria-label="Deletar lead"><i class="ph ph-trash"></i></button>' +
          '</div>';

        tr.innerHTML =
          '<td>' + leadCellHtml + '</td>' +
          '<td>' + waCellHtml + '</td>' +
          '<td>' + tagsHtml + '</td>' +
          '<td>' + actionsHtml + '</td>';

        (function(leadCopy, trEl){
          var av = trEl.querySelector('[data-avatar]');
          if (av){
            av.addEventListener("click", function(){ openLeadDetails(leadCopy); });
          }
          var chatBtn = trEl.querySelector('[data-lead-chat]');
          if (chatBtn){
            chatBtn.addEventListener("click", function(){
              openConversationFromInsight({
                whatsapp_digits: leadCopy.whatsapp_digits || leadCopy.whatsapp_raw || "",
                nome: leadCopy.nome || "",
                empresa: leadCopy.empresa || "",
                email: leadCopy.email || ""
              });
            });
          }

          var bt = trEl.querySelector('[data-tags]');
          if (bt){
            bt.addEventListener("click", function(){
              openTagsEditor({
                id: leadCopy.id,
                nome: leadCopy.nome,
                whatsapp_digits: leadCopy.whatsapp_digits,
                whatsapp_raw: leadCopy.whatsapp_raw,
                tagIds: leadCopy.tagIds || []
              });
            });
          }

          var del = trEl.querySelector('[data-delete-lead]');
          if (del){
            del.addEventListener("click", function(){
              deleteLeadFromList(leadCopy, del);
            });
          }
        })(lead, tr);

        tbody.appendChild(tr);
      }

      pageInfo.textContent = "Página " + (pageIndex + 1) + " de " + totalPages + " | Total de resultados: " + total;

      btnPrev.disabled = !leadPageMeta.hasPrev;
      btnNext.disabled = !leadPageMeta.hasNext;

      // nav count
      document.getElementById("navLeadsCount").textContent = String(total);
      renderActiveFiltersSummary();
    }

    btnPrev.addEventListener("click", function(){
      if (!leadPageMeta.hasPrev) return;
      pageIndex = Math.max(0, pageIndex - 1);
      loadLeads(false).catch(function(err){ toast("err", "Paginação", err.message || "Falha ao carregar a página anterior."); });
    });
    btnNext.addEventListener("click", function(){
      if (!leadPageMeta.hasNext) return;
      pageIndex += 1;
      loadLeads(false).catch(function(err){ toast("err", "Paginação", err.message || "Falha ao carregar a próxima página."); });
    });
    pageSizeEl.addEventListener("change", function(){
      pageSize = Number(pageSizeEl.value || 200);
      pageIndex = 0;
      loadLeads(true).catch(function(err){ toast("err", "Paginação", err.message || "Falha ao alterar o tamanho da página."); });
    });

    function buildLeadQueryParams(){
      var q = (document.getElementById("q").value || "").trim();
      var p = new URLSearchParams();
      if (q) p.set("q", q);
      if (filters.ddd) p.set("ddd", filters.ddd);
      if (filters.from) p.set("from", filters.from);
      if (filters.to) p.set("to", filters.to);
      if (filters.status) p.set("status", filters.status);
      if (filters.tagIds && filters.tagIds.length) p.set("tags", filters.tagIds.join(","));
      p.set("notDeliveredAfterMin", String(STATUS_FILTER_TIMEOUT_MIN));
      p.set("page", String(pageIndex + 1));
      p.set("pageSize", String(pageSize));
      p.set("sortBy", "createdAt");
      p.set("sortDir", "desc");
      return p;
    }

    async function fetchAllLeadPages(params){
      var base = params instanceof URLSearchParams ? new URLSearchParams(params.toString()) : new URLSearchParams();
      base.delete("page");
      base.set("pageSize", "500");
      var all = [];
      var page = 1;
      var total = null;
      while (page <= 10000){
        base.set("page", String(page));
        var response = await fetch(API_BASE + "/leads?" + base.toString());
        var payload = await response.json().catch(function(){ return {}; });
        if (!response.ok) throw new Error(payload.error || "Falha ao carregar todos os leads.");
        var rows = Array.isArray(payload.items) ? payload.items : [];
        all = all.concat(rows);
        total = Number.isFinite(Number(payload.total)) ? Number(payload.total) : all.length;
        if (!payload.hasNext || !rows.length) break;
        page += 1;
      }
      if (total != null && all.length < total) throw new Error("A paginação de leads foi interrompida antes de carregar todos os registros.");
      return all;
    }

    async function loadLeads(resetPage){
      if (resetPage) pageIndex = 0;
      setLoadingRows();

      var p = buildLeadQueryParams();
      var url = API_BASE + "/leads" + (p.toString() ? ("?" + p.toString()) : "");
      var res = await fetch(url);
      var json = await res.json();
      if (!res.ok) throw new Error(json.error || "Falha ao carregar leads");

      if (Array.isArray(json.tags)) cachedTags = json.tags;

      itemsAll = Array.isArray(json.items) ? json.items : [];
      filteredItems = itemsAll;
      filteredTotal = Number.isFinite(Number(json.total)) ? Number(json.total) : itemsAll.length;
      leadPageMeta = {
        page: Number(json.page || (pageIndex + 1)),
        pageSize: Number(json.pageSize || pageSize),
        totalPages: Number(json.totalPages || 1),
        hasNext: Boolean(json.hasNext),
        hasPrev: Boolean(json.hasPrev)
      };
      pageIndex = Math.max(0, leadPageMeta.page - 1);

      var csv = document.getElementById("csv");
      var csvParams = new URLSearchParams(p.toString());
      ["page", "pageSize"].forEach(function(key){ csvParams.delete(key); });
      setSafeElementUrl(csv, "href", APP_CONFIG.csvBase + (csvParams.toString() ? ("?" + csvParams.toString()) : ""), { sameOrigin: true });

      lastSync.textContent = "Atualizado: " + new Date().toLocaleString("pt-BR");
      renderPage();
    }

    /* ---------- Search ---------- */
    var qEl = document.getElementById("q");
    var searchDebounceTimer = null;
    qEl.addEventListener("keydown", function(e){
      if (e.key === "Enter") {
        clearTimeout(searchDebounceTimer);
        loadLeads(true).catch(function(err){ toast("err", "Busca", err.message || "Falha ao buscar leads."); });
      }
    });
    qEl.addEventListener("input", function(){
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(function(){
        loadLeads(true).catch(function(err){ toast("err", "Busca", err.message || "Falha ao buscar leads."); });
      }, 420);
    });
    document.getElementById("btnReload").addEventListener("click", function(){ loadLeads(false); });
    document.addEventListener("keydown", function(e){
      if (e.key === "/" && !/input|textarea|select/i.test(document.activeElement && document.activeElement.tagName || "")) {
        e.preventDefault();
        qEl.focus();
      }
      if (e.key === "Escape") {
        ["ovLead","ovInsightDdd","ovQr","ovTemplate","ovTags","ovFilters"].forEach(closeOverlay);
        if (typeof closeTagDrawer === "function") closeTagDrawer();
      }
    });

    /* ---------- Sidebar nav ---------- */
    var navLeads = document.getElementById("navLeads");
    var navTags = document.getElementById("navTags");
    var navChats = document.getElementById("navChats");
    var navInsights = document.getElementById("navInsights");
    var navCloud = document.getElementById("navCloud");
    var navCrm = document.getElementById("navCrm");
    var navOwner = document.getElementById("navOwner");
    var panelTags = document.getElementById("panelTags");
    var panelLeads = document.getElementById("panelLeads");
    var panelChats = document.getElementById("panelChats");
    var panelInsights = document.getElementById("panelInsights");
    var panelCloudMain = document.getElementById("panelCloudMain");
    var panelCrm = document.getElementById("panelCrm");
    var panelOwner = document.getElementById("panelOwner");

    
    function openTagDrawer(){
      var ov = document.getElementById("ovTagDrawer");
      if (!ov) return;
      ov.style.display = "flex";
      ov.setAttribute("aria-hidden","false");
      document.body.classList.add("noScroll");
    }
    function closeTagDrawer(){
      var ov = document.getElementById("ovTagDrawer");
      if (!ov) return;
      ov.style.display = "none";
      ov.setAttribute("aria-hidden","true");
      if (navTags) navTags.classList.remove("active");
      if (!anyOverlayOpen()) document.body.classList.remove("noScroll");
    }

    function setMainPanelScrollTop(panel){
      try {
        if (panel && typeof panel.scrollTo === "function") panel.scrollTo({ top: 0, left: 0, behavior: "smooth" });
        else if (panel) panel.scrollTop = 0;
      } catch(e) { if (panel) panel.scrollTop = 0; }
    }

    function togglePagerForLeads(show){
      try {
        if (typeof window.setPagerVisible === "function") window.setPagerVisible(!!show);
        else {
          var bar = document.getElementById("pagerBar") || document.querySelector(".pager");
          if (bar) bar.classList.toggle("is-hidden", !show);
        }
      } catch(e) {}
    }

    function setActiveNav(which){
      if (which === "tags"){
        // Tags agora abre como sobreposição e mantém a tela atual exatamente como está.
        // Não troca o painel principal, não volta para Leads e não altera o scroll.
        if (navTags) navTags.classList.add("active");
        openTagDrawer();
        return;
      }

      try { document.body.classList.toggle("cloudFullMode", which === "cloud"); } catch(e) {}

      if (which === "chats"){
        if (navChats) navChats.classList.add("active");
        navLeads.classList.remove("active");
        navTags.classList.remove("active");
        navCloud.classList.remove("active");
        if (navCrm) navCrm.classList.remove("active");
        if (navOwner) navOwner.classList.remove("active");
        if (navInsights) navInsights.classList.remove("active");

        closeTagDrawer();

        panelLeads.style.display = "none";
        if (panelChats) panelChats.style.display = "none";
        if (panelInsights) panelInsights.style.display = "none";
        if (panelCrm) panelCrm.style.display = "none";
        if (panelOwner) panelOwner.style.display = "none";
        if (panelInsights) panelInsights.style.display = "none";
        panelCloudMain.style.display = "none";
        if (panelChats) panelChats.style.display = "flex";
        togglePagerForLeads(false);
        setMainPanelScrollTop(panelChats);
        try{ loadConversations({ keepSelected: true }); }catch(e){}
        try{ startChatAutoRefresh(); }catch(e){}
        return;
      }


      if (which === "insights"){
        if (navInsights) navInsights.classList.add("active");
        if (navChats) navChats.classList.remove("active");
        if (navOwner) navOwner.classList.remove("active");
        navCloud.classList.remove("active");
        navLeads.classList.remove("active");
        navTags.classList.remove("active");
        if (navCrm) navCrm.classList.remove("active");

        closeTagDrawer();
        try{ stopChatAutoRefresh(); }catch(e){}

        panelLeads.style.display = "none";
        if (panelChats) panelChats.style.display = "none";
        if (panelInsights) panelInsights.style.display = "none";
        if (panelCrm) panelCrm.style.display = "none";
        if (panelOwner) panelOwner.style.display = "none";
        panelCloudMain.style.display = "none";
        if (panelInsights) panelInsights.style.display = "flex";
        togglePagerForLeads(false);
        setMainPanelScrollTop(panelInsights);
        try{ loadInsights(); }catch(e){}
        return;
      }

      if (which === "crm"){
        navCrm.classList.add("active");
        if (navChats) navChats.classList.remove("active");
        if (navInsights) navInsights.classList.remove("active");
        if (navOwner) navOwner.classList.remove("active");
        navCloud.classList.remove("active");
        navLeads.classList.remove("active");
        navTags.classList.remove("active");

        closeTagDrawer();

        panelLeads.style.display = "none";
        if (panelChats) panelChats.style.display = "none";
        if (panelInsights) panelInsights.style.display = "none";
        panelCloudMain.style.display = "none";
        if (panelOwner) panelOwner.style.display = "none";
        if (panelCrm) panelCrm.style.display = "flex";
        togglePagerForLeads(false);
        setMainPanelScrollTop(panelCrm);
        // carrega CRM sempre que entrar
        try{ crmBoot(); }catch(e){}
        return;
      }



      if (which === "owner"){
        if (navOwner) navOwner.classList.add("active");
        if (navChats) navChats.classList.remove("active");
        navLeads.classList.remove("active");
        navTags.classList.remove("active");
        navCloud.classList.remove("active");
        if (navCrm) navCrm.classList.remove("active");

        closeTagDrawer();

        panelLeads.style.display = "none";
        if (panelChats) panelChats.style.display = "none";
        if (panelInsights) panelInsights.style.display = "none";
        panelCloudMain.style.display = "none";
        if (panelChats) panelChats.style.display = "none";
        if (panelInsights) panelInsights.style.display = "none";
        if (panelCrm) panelCrm.style.display = "none";
        if (panelOwner) panelOwner.style.display = "flex";
        togglePagerForLeads(false);
        setMainPanelScrollTop(panelOwner);
        try{ loadOwner(); }catch(e){}
        return;
      }

      if (which === "cloud"){
        navCloud.classList.add("active");
        if (navChats) navChats.classList.remove("active");
        if (navInsights) navInsights.classList.remove("active");
        if (navOwner) navOwner.classList.remove("active");
        navLeads.classList.remove("active");
        navTags.classList.remove("active");
        if (navCrm) navCrm.classList.remove("active");

        closeTagDrawer();

        panelLeads.style.display = "none";
        if (panelChats) panelChats.style.display = "none";
        if (panelInsights) panelInsights.style.display = "none";
        if (panelCrm) panelCrm.style.display = "none";
        if (panelOwner) panelOwner.style.display = "none";
        panelCloudMain.style.display = "flex";
        togglePagerForLeads(false);
        setMainPanelScrollTop(panelCloudMain);
        try{ loadCloudStatus(); }catch(e){}
        try{ cloudListTemplates(); }catch(e){}
        return;
      }

      // leads
      navLeads.classList.add("active");
      if (navChats) navChats.classList.remove("active");
      if (navInsights) navInsights.classList.remove("active");
      if (navOwner) navOwner.classList.remove("active");
      navTags.classList.remove("active");
      navCloud.classList.remove("active");
      if (navCrm) navCrm.classList.remove("active");
      panelCloudMain.style.display = "none";
      if (panelChats) panelChats.style.display = "none";
      if (panelInsights) panelInsights.style.display = "none";
      if (panelCrm) panelCrm.style.display = "none";
      panelLeads.style.display = "flex";
      togglePagerForLeads(true);
      setMainPanelScrollTop(panelLeads);
      closeTagDrawer();
    }

    navLeads.addEventListener("click", function(){ setActiveNav("leads"); });
    if (navChats) navChats.addEventListener("click", function(){ setActiveNav("chats"); });
    if (navInsights) navInsights.addEventListener("click", function(){ setActiveNav("insights"); });
    navTags.addEventListener("click", function(){ setActiveNav("tags"); });
    navCloud.addEventListener("click", function(){ setActiveNav("cloud"); });
    if (navCrm) navCrm.addEventListener("click", function(){ setActiveNav("crm"); });
    if (navOwner) navOwner.addEventListener("click", function(){ setActiveNav("owner"); });


    /* ---------- Insights ---------- */
    var insightsCache = null;

    function insFmt(n){
      var num = Number(n || 0);
      try { return num.toLocaleString("pt-BR"); } catch(e){ return String(num); }
    }
    function insPct(n){
      var num = Number(n || 0);
      return (Number.isFinite(num) ? num : 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%";
    }
    function insDate(iso){
      if (!iso) return "—";
      var d = new Date(iso);
      if (isNaN(d)) return "—";
      return d.toLocaleString("pt-BR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
    }
    function insShort(text, max){
      var s = String(text || "").trim();
      var m = Number(max || 90);
      return s.length > m ? s.slice(0, m - 1) + "…" : s;
    }
    function insEmpty(text){
      return '<div class="insightEmpty">' + escapeHtml(text || "Sem dados suficientes ainda.") + '</div>';
    }
    function insBarRows(items, opts){
      opts = opts || {};
      var rows = Array.isArray(items) ? items : [];
      if (!rows.length) return insEmpty(opts.empty || "Sem dados para exibir.");
      var max = Math.max.apply(null, rows.map(function(x){ return Number(x.count || x.total || 0); }).concat([1]));
      return '<div class="insightBars">' + rows.map(function(x){
        var count = Number(x.count || x.total || 0);
        var label = x.label || x.name || x.ddd || x.key || "Item";
        var w = Math.max(3, Math.round((count / max) * 100));
        return '<div class="insightBarRow">' +
          '<div class="insightBarLabel" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</div>' +
          '<div class="insightBarTrack"><div class="insightBarFill" style="width:' + w + '%"></div></div>' +
          '<div class="insightBarNumber">' + insFmt(count) + (x.percentage != null ? ' · ' + insPct(x.percentage) : '') + '</div>' +
        '</div>';
      }).join('') + '</div>';
    }

    function insDateLabel(dateStr){
      var s = String(dateStr || "");
      var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) return m[3] + "/" + m[2];
      return s || "—";
    }

    function insLeadStatusLabel(status){
      var s = String(status || "none");
      var map = { replied:"Respondeu", delivered:"Recebeu", notDelivered:"Erro", notExists:"Não existe", pending:"Pendente", none:"Sem status" };
      return map[s] || map.none;
    }
    function insLeadStatusClass(status){
      var s = String(status || "none");
      if (["replied","delivered","notDelivered","notExists","pending"].indexOf(s) >= 0) return s;
      return "none";
    }
    function renderInsightLeadStatusDot(status){
      var cls = insLeadStatusClass(status);
      return '<span class="insightLeadStatusDot status-' + cls + '" title="' + escapeHtml(insLeadStatusLabel(cls)) + '"></span>';
    }
    function insStripUrls(text){
      return String(text || "").replace(/https?:\/\/\S+/gi, "").replace(/\s{2,}/g, " ").trim();
    }
    function insCompactUrl(text, max){
      var s = String(text || "").trim();
      if (!s) return "";
      try{
        var u = new URL(s);
        var token = (u.pathname || "").split("/").filter(Boolean).pop() || "";
        var shortToken = token ? token.slice(0, 8) + (token.length > 8 ? "…" : "") : "";
        return u.hostname + (shortToken ? "/" + shortToken : "");
      }catch(_){
        return insShort(s, max || 34);
      }
    }
    function insCompactOriginLabel(label, detail){
      var raw = String(label || detail || "Origem").trim();
      var url = raw.match(/https?:\/\/\S+/i);
      if (url) return raw.replace(url[0], insCompactUrl(url[0], 34));
      return insShort(raw.replace(/^Webhook:\s*Webhook:\s*/i, "Webhook: "), 46);
    }
    function insCleanOriginDetail(detail){
      var s = insStripUrls(detail || "");
      s = s.replace(/^Webhook\s+/i, "Webhook ");
      if (!s) return "Origem registrada no sistema.";
      return insShort(s, 220);
    }
    function insLeadRowNameHtml(l){
      var digits = String((l && (l.whatsapp_digits || l.whatsapp_raw)) || "").replace(/\D+/g, "");
      var name = (l && l.nome) || formatWhatsAppPretty(digits) || "Lead";
      var meta = [(l && l.empresa) || "", (l && l.email) || "", digits ? formatWhatsAppPretty(digits) : ""].filter(Boolean).join(" · ");
      return '<div class="insightLeadCell">' + renderInsightLeadStatusDot(l && l.status) + '<div class="insightLeadCellMain"><b>' + escapeHtml(name) + '</b><div class="insightSourceDetail">' + escapeHtml(meta || "Sem dados complementares") + '</div></div></div>';
    }
    function insLeadChatButton(l){
      var digits = String((l && (l.whatsapp_digits || l.whatsapp_raw)) || "").replace(/\D+/g, "");
      if (!digits) return '<span class="hint">Sem WhatsApp</span>';
      return '<button class="btn btnSoft insightChatBtn" type="button" data-insight-list-chat="' + escapeHtml(digits) + '" data-insight-name="' + escapeHtml((l && l.nome) || '') + '" data-insight-company="' + escapeHtml((l && l.empresa) || '') + '" data-insight-email="' + escapeHtml((l && l.email) || '') + '"><i class="ph ph-chat-circle-text"></i> Conversar</button>';
    }
    function openInsightListModal(title, subtitle, leads, opts){
      opts = opts || {};
      var ov = document.getElementById("ovInsightList");
      var titleEl = document.getElementById("insListModalTitle");
      var subEl = document.getElementById("insListModalSub");
      var summary = document.getElementById("insListModalSummary");
      var content = document.getElementById("insListModalContent");
      var rows = Array.isArray(leads) ? leads : [];
      if (titleEl) titleEl.textContent = title || "Leads";
      if (subEl) subEl.textContent = subtitle || "Visualização rápida dos leads deste recorte.";
      var withPhone = rows.filter(function(l){ return String((l && (l.whatsapp_digits || l.whatsapp_raw)) || "").replace(/\D+/g,""); }).length;
      var replied = rows.filter(function(l){ return String(l && l.status) === "replied"; }).length;
      if (summary) {
        summary.innerHTML = '<div class="insListMetric"><b>' + insFmt(rows.length) + '</b><span>Leads</span></div>' +
          '<div class="insListMetric"><b>' + insFmt(withPhone) + '</b><span>Com WhatsApp</span></div>' +
          '<div class="insListMetric"><b>' + insFmt(replied) + '</b><span>Responderam</span></div>';
      }
      if (content) {
        content.innerHTML = rows.length ? '<table class="insListLeadTable"><thead><tr><th>Lead</th><th>Origem / Detalhe</th><th>Data</th><th>Ação</th></tr></thead><tbody>' + rows.map(function(l){
          return '<tr><td>' + insLeadRowNameHtml(l || {}) + '</td><td><b>' + escapeHtml((l && (l.originLabel || l.source)) || "Origem") + '</b><div class="insightSourceDetail">' + escapeHtml(insCleanOriginDetail((l && l.originDetail) || "")) + '</div></td><td>' + escapeHtml(insDate((l && (l.createdAt || l.updatedAt)) || "")) + '</td><td>' + insLeadChatButton(l || {}) + '</td></tr>';
        }).join('') + '</tbody></table>' : insEmpty("Nenhum lead encontrado neste recorte.");
      }
      if (ov) ov.style.display = "flex";
      bindInsightModalChatButtons();
    }
    function closeInsightListModal(){
      var ov = document.getElementById("ovInsightList");
      if (ov) ov.style.display = "none";
    }
    function bindInsightModalChatButtons(){
      var wrap = document.getElementById("ovInsightList") || document;
      wrap.querySelectorAll("[data-insight-list-chat]").forEach(function(btn){
        if (btn.getAttribute("data-insight-list-bound") === "1") return;
        btn.setAttribute("data-insight-list-bound", "1");
        btn.addEventListener("click", function(){
          closeInsightListModal();
          openConversationFromInsight({
            whatsapp_digits: btn.getAttribute("data-insight-list-chat") || "",
            nome: btn.getAttribute("data-insight-name") || "",
            empresa: btn.getAttribute("data-insight-company") || "",
            email: btn.getAttribute("data-insight-email") || ""
          });
        });
      });
    }

    function insightTimelineStats(tl){
      var rows = Array.isArray(tl) ? tl : [];
      var total = rows.reduce(function(acc, x){ return acc + Number(x.count || 0); }, 0);
      var max = rows.reduce(function(acc, x){ return Math.max(acc, Number(x.count || 0)); }, 0);
      var activeDays = rows.filter(function(x){ return Number(x.count || 0) > 0; }).length;
      return { total: total, max: max, activeDays: activeDays };
    }

    function timelineRowsForCurrentRange(){
      var tl = insightsCache && insightsCache.timeline ? insightsCache.timeline : {};
      if (insightTimelineRange === "custom") {
        var from = document.getElementById("insTimelineFrom");
        var to = document.getElementById("insTimelineTo");
        var fromVal = from ? from.value : "";
        var toVal = to ? to.value : "";
        if (fromVal && toVal && fromVal <= toVal) {
          var allCounts = {};
          (Array.isArray(tl.allDays) ? tl.allDays : []).forEach(function(x){ allCounts[String(x.date)] = Number(x.count || 0); });
          var out = [];
          var cur = new Date(fromVal + "T00:00:00");
          var last = new Date(toVal + "T00:00:00");
          var guard = 0;
          while (!isNaN(cur) && !isNaN(last) && cur <= last && guard < 370) {
            var y = cur.getFullYear();
            var m = String(cur.getMonth() + 1).padStart(2, "0");
            var d = String(cur.getDate()).padStart(2, "0");
            var key = y + "-" + m + "-" + d;
            out.push({ date:key, count: allCounts[key] || 0, leads: (tl.dayLeads && tl.dayLeads[key]) || [] });
            cur.setDate(cur.getDate() + 1);
            guard++;
          }
          return out;
        }
      }
      if (insightTimelineRange === "7") return Array.isArray(tl.last7) ? tl.last7 : [];
      if (insightTimelineRange === "60") return Array.isArray(tl.last60) ? tl.last60 : [];
      return Array.isArray(tl.last30) ? tl.last30 : [];
    }

    function renderInsightTimeline(tl){
      var rows = Array.isArray(tl) ? tl : timelineRowsForCurrentRange();
      var maxTl = Math.max.apply(null, rows.map(function(x){ return Number(x.count || 0); }).concat([1]));
      var summary = document.getElementById("insTimelineSummary");
      var labels = document.getElementById("insTimelineLabels");
      var timeline = document.getElementById("insTimeline");
      var st = insightTimelineStats(rows);
      if (summary) {
        summary.innerHTML = '<div class="insightTimelineMetric"><b>' + insFmt(st.total) + '</b><span>Total no período</span></div>' +
          '<div class="insightTimelineMetric"><b>' + insFmt(st.max) + '</b><span>Melhor dia</span></div>' +
          '<div class="insightTimelineMetric"><b>' + insFmt(st.activeDays) + '</b><span>Dias com leads</span></div>';
      }
      if (timeline) {
        timeline.innerHTML = rows.length ? rows.map(function(x){
          var count = Number(x.count || 0);
          var h = Math.max(4, Math.round((count / maxTl) * 140));
          var cls = count > 0 ? '' : ' is-empty';
          return '<button class="insightTimelineBar' + cls + '" type="button" style="height:' + h + 'px" data-insight-day="' + escapeHtml(x.date || '') + '" data-tip="' + escapeHtml(insDateLabel(x.date) + ': ' + insFmt(count) + ' lead(s)') + '"></button>';
        }).join('') : insEmpty("Ainda não há leads no período.");
        bindInsightTimelineDayButtons();
      }
      if (labels) {
        var first = rows[0] ? insDateLabel(rows[0].date) : "—";
        var mid = rows[Math.floor(rows.length / 2)] ? insDateLabel(rows[Math.floor(rows.length / 2)].date) : "—";
        var last = rows[rows.length - 1] ? insDateLabel(rows[rows.length - 1].date) : "—";
        labels.innerHTML = '<span>' + escapeHtml(first) + '</span><span>' + escapeHtml(mid) + '</span><span>' + escapeHtml(last) + '</span>';
      }
    }

    function bindInsightTimelineDayButtons(){
      var timeline = document.getElementById("insTimeline");
      if (!timeline) return;
      timeline.querySelectorAll("[data-insight-day]").forEach(function(btn){
        if (btn.getAttribute("data-ins-day-bound") === "1") return;
        btn.setAttribute("data-ins-day-bound", "1");
        btn.addEventListener("click", function(){
          var day = btn.getAttribute("data-insight-day") || "";
          if (!day) return;
          var tl = insightsCache && insightsCache.timeline ? insightsCache.timeline : {};
          var rows = (tl.dayLeads && tl.dayLeads[day]) || [];
          if (!rows.length) {
            toast("warn", "Leads do dia", "Nenhum lead encontrado neste dia.");
            return;
          }
          openInsightListModal("Leads de " + insDateLabel(day), rows.length + " lead(s) cadastrados neste dia.", rows);
        });
      });
    }

    var insightTimelineRange = "7";
    var selectedInsightDdd = "";

    var insightDddModalItem = null;

    function insightDddKey(item){
      return String(item && (item.groupKey || ((item.country ? item.country + ":" : "") + (item.ddd || item.prefix || ""))) || "");
    }

    function insightDddLabel(item){
      if (!item) return "Região";
      if (item.label) return String(item.label);
      var ddd = String(item.ddd || item.prefix || "");
      if (String(item.country || "") === "PT") return "Portugal " + ddd;
      return "DDD " + ddd;
    }

    function renderInsightDdds(ddds){
      var rows = Array.isArray(ddds) ? ddds : [];
      var box = document.getElementById("insDdds");
      var detail = document.getElementById("insDddDetail");
      if (detail) detail.innerHTML = "";
      if (!box) return;
      if (!rows.length) {
        box.innerHTML = insEmpty("Nenhum DDD ou prefixo de Portugal identificado ainda.");
        return;
      }
      var max = Math.max.apply(null, rows.map(function(x){ return Number(x.count || 0); }).concat([1]));
      box.innerHTML = '<div class="insightBars">' + rows.map(function(x){
        var count = Number(x.count || 0);
        var w = Math.max(3, Math.round((count / max) * 100));
        var key = insightDddKey(x);
        var label = insightDddLabel(x);
        var active = selectedInsightDdd === key ? ' btnPrimary' : ' btnSoft';
        return '<div class="insightBarRow withAction">' +
          '<div class="insightBarLabel" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</div>' +
          '<div class="insightBarTrack"><div class="insightBarFill" style="width:' + w + '%"></div></div>' +
          '<div class="insightBarNumber">' + insFmt(count) + ' · ' + insPct(x.percentage) + '</div>' +
          '<button class="btn insightMiniAction' + active + '" type="button" data-insight-ddd="' + escapeHtml(key) + '"><i class="ph ph-list-magnifying-glass"></i> Ver números</button>' +
        '</div>';
      }).join('') + '</div>';
      bindInsightDddButtons();
    }

    function bindInsightDddButtons(){
      var wrap = document.getElementById("insDdds");
      if (!wrap) return;
      wrap.querySelectorAll("[data-insight-ddd]").forEach(function(btn){
        btn.addEventListener("click", function(){
          selectedInsightDdd = btn.getAttribute("data-insight-ddd") || "";
          renderInsightDdds((insightsCache && insightsCache.ddds) || []);
          openInsightDddModal(selectedInsightDdd);
        });
      });
    }

    function getInsightDddItem(ddd){
      var rows = (insightsCache && Array.isArray(insightsCache.ddds) ? insightsCache.ddds : []);
      var wanted = String(ddd || "");
      return rows.find(function(x){
        return insightDddKey(x) === wanted || String(x.ddd || "") === wanted || String(x.prefix || "") === wanted;
      }) || null;
    }

    function insightDddRows(){
      return insightDddModalItem && Array.isArray(insightDddModalItem.leads) ? insightDddModalItem.leads : [];
    }

    function insightDddSelectedLeadIds(){
      var wrap = document.getElementById("insDddModalList");
      if (!wrap) return [];
      return Array.from(wrap.querySelectorAll('input[data-ins-ddd-lead]:checked'))
        .map(function(x){ return x.getAttribute("data-ins-ddd-lead") || ""; })
        .filter(Boolean);
    }

    function insightDddSelectedLeads(){
      var ids = new Set(insightDddSelectedLeadIds().map(String));
      return insightDddRows().filter(function(l){ return ids.has(String(l.id || "")); });
    }

    function updateInsightDddSelectedCount(){
      var count = insightDddSelectedLeadIds().length;
      var total = insightDddRows().length;
      var el = document.getElementById("insDddSelectedCount");
      if (el) el.textContent = insFmt(count) + " de " + insFmt(total) + " selecionado(s)";
      var all = document.getElementById("insDddSelectAll");
      if (all) {
        all.checked = total > 0 && count === total;
        all.indeterminate = count > 0 && count < total;
      }
    }

    function renderInsightDddTagSelect(){
      var select = document.getElementById("insDddTagSelect");
      if (!select) return;
      var tags = Array.isArray(cachedTags) ? cachedTags : [];
      if (!tags.length) {
        select.innerHTML = '<option value="">Nenhuma tag criada ainda</option>';
        return;
      }
      select.innerHTML = '<option value="">Selecione uma tag</option>' + tags.map(function(t){
        return '<option value="' + escapeHtml(t.id || "") + '">' + escapeHtml(t.name || t.id || "Tag") + '</option>';
      }).join('');
    }

    function renderInsightDddModalTable(){
      var box = document.getElementById("insDddModalList");
      if (!box) return;
      var leads = insightDddRows();
      if (!leads.length) {
        box.innerHTML = insEmpty("Não encontramos contatos para esta região.");
        updateInsightDddSelectedCount();
        return;
      }
      box.innerHTML = '<table class="insightTable"><thead><tr>' +
        '<th class="insightCheckCell"><input id="insDddTableSelectAll" type="checkbox" checked aria-label="Selecionar todos"></th>' +
        '<th>Lead</th><th>WhatsApp</th><th>Origem</th><th>Tags</th><th>Ações</th>' +
        '</tr></thead><tbody>' + leads.map(function(l){
          var digits = String(l.whatsapp_digits || "").replace(/\D+/g, "");
          var line = [l.nome || "Sem nome", digits, l.empresa || "", l.email || ""].filter(Boolean).join(" | ");
          var tagHtml = Array.isArray(l.tags) && l.tags.length ? l.tags.map(function(t){
            return '<span class="insightTagPill"><span class="insightTagDot" style="background:' + safeCssColor(t.color, '#64748b') + '"></span>' + escapeHtml(t.name || t.id) + '</span>';
          }).join('') : '<span class="hint">—</span>';
          return '<tr>' +
            '<td class="insightCheckCell"><input type="checkbox" checked data-ins-ddd-lead="' + escapeHtml(l.id || '') + '"></td>' +
            '<td><b>' + escapeHtml(l.nome || formatWhatsAppPretty(digits) || 'Lead') + '</b><div class="insightSourceDetail">' + escapeHtml([l.empresa,l.email].filter(Boolean).join(' · ')) + '</div></td>' +
            '<td><b>' + escapeHtml(formatWhatsAppPretty(digits) || digits || '—') + '</b><div class="insightSourceDetail">' + escapeHtml(insDate(l.createdAt)) + '</div></td>' +
            '<td><b>' + escapeHtml(l.originLabel || l.source || 'Origem') + '</b><div class="insightSourceDetail">' + escapeHtml(l.originDetail || '') + '</div></td>' +
            '<td>' + tagHtml + '</td>' +
            '<td><div class="insightActionGroup"><button class="btn btnSoft insightChatBtn" type="button" data-insight-chat="' + escapeHtml(digits) + '" data-insight-name="' + escapeHtml(l.nome || '') + '" data-insight-company="' + escapeHtml(l.empresa || '') + '" data-insight-email="' + escapeHtml(l.email || '') + '"><i class="ph ph-chat-circle-text"></i> Conversar</button><button class="btn btnGhost insightCopyBtn" type="button" data-insight-copy="' + escapeHtml(line) + '"><i class="ph ph-copy"></i> Copiar</button></div></td>' +
          '</tr>';
        }).join('') + '</tbody></table>';

      var tableAll = document.getElementById("insDddTableSelectAll");
      if (tableAll) tableAll.addEventListener("change", function(){ setInsightDddSelection(tableAll.checked); });
      box.querySelectorAll('input[data-ins-ddd-lead]').forEach(function(chk){
        chk.addEventListener("change", updateInsightDddSelectedCount);
      });
      updateInsightDddSelectedCount();
      bindInsightCopyButtons();
      bindInsightChatButtons();
    }

    function setInsightDddSelection(checked){
      var wrap = document.getElementById("insDddModalList");
      if (!wrap) return;
      wrap.querySelectorAll('input[data-ins-ddd-lead]').forEach(function(chk){ chk.checked = !!checked; });
      updateInsightDddSelectedCount();
    }

    function openInsightDddModal(ddd){
      var item = getInsightDddItem(ddd);
      if (!item) {
        toast("warn", "Região", "Não encontrei contatos dessa região.");
        return;
      }
      insightDddModalItem = item;
      var leads = insightDddRows();
      var title = document.getElementById("insDddModalTitle");
      var sub = document.getElementById("insDddModalSub");
      var summary = document.getElementById("insDddSummary");
      var regionLabel = insightDddLabel(item);
      if (title) title.textContent = regionLabel + " · " + insFmt(item.count) + " lead(s)";
      if (sub) sub.textContent = "Agora você pode exportar, copiar, marcar com tag, filtrar no painel ou abrir conversa com os contatos dessa região.";
      if (summary) {
        var withCompany = leads.filter(function(l){ return !!String(l.empresa || '').trim(); }).length;
        var withEmail = leads.filter(function(l){ return !!String(l.email || '').trim(); }).length;
        var withTags = leads.filter(function(l){ return Array.isArray(l.tags) && l.tags.length; }).length;
        summary.innerHTML = '<div class="insightDddSummaryItem"><b>' + insFmt(leads.length) + '</b><span>contatos na tela</span></div>' +
          '<div class="insightDddSummaryItem"><b>' + insFmt(withCompany) + '</b><span>com empresa</span></div>' +
          '<div class="insightDddSummaryItem"><b>' + insFmt(withEmail) + '</b><span>com e-mail</span></div>' +
          '<div class="insightDddSummaryItem"><b>' + insFmt(withTags) + '</b><span>com tag</span></div>';
      }
      renderInsightDddTagSelect();
      renderInsightDddModalTable();
      openOverlay("ovInsightDdd");
      if (!cachedTags || !cachedTags.length) {
        fetchTags().then(renderInsightDddTagSelect).catch(function(){});
      }
    }

    function insightCsvEscape(v){
      var s = String(v == null ? "" : v);
      if (/[";\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }

    function downloadInsightDddCsv(){
      var rows = insightDddSelectedLeads();
      if (!rows.length) { toast("warn", "Exportar", "Selecione pelo menos um lead."); return; }
      var ddd = insightDddModalItem ? String(insightDddModalItem.filterValue || insightDddModalItem.ddd || insightDddModalItem.prefix || "") : "regiao";
      var header = ["nome","whatsapp","empresa","email","origem","detalhe_origem","tags","data"];
      var lines = [header.join(";")].concat(rows.map(function(l){
        var tags = Array.isArray(l.tags) ? l.tags.map(function(t){ return t.name || t.id || ""; }).filter(Boolean).join(", ") : "";
        return [l.nome || "", String(l.whatsapp_digits || "").replace(/\D+/g, ""), l.empresa || "", l.email || "", l.originLabel || l.source || "", l.originDetail || "", tags, insDate(l.createdAt)].map(insightCsvEscape).join(";");
      }));
      var blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a");
      setSafeElementUrl(a, "href", URL.createObjectURL(blob), { allowBlob: true });
      a.download = "leads-ddd-" + ddd + ".csv";
      document.body.appendChild(a);
      a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast("ok", "Planilha", "Arquivo CSV gerado para abrir no Excel ou Google Sheets.");
    }

    function copyInsightDddPhones(){
      var rows = insightDddSelectedLeads();
      if (!rows.length) { toast("warn", "Copiar", "Selecione pelo menos um lead."); return; }
      var text = rows.map(function(l){ return String(l.whatsapp_digits || "").replace(/\D+/g, ""); }).filter(Boolean).join("\n");
      copyInsightText(text);
    }

    function filterLeadPanelByInsightDdd(){
      var ddd = insightDddModalItem ? String(insightDddModalItem.filterValue || insightDddModalItem.ddd || insightDddModalItem.prefix || "") : selectedInsightDdd;
      if (!ddd) return;
      filters.ddd = ddd;
      filters.status = "";
      filters.tagIds = [];
      var q = document.getElementById("q");
      if (q) q.value = "";
      syncFiltersUI();
      syncQuickStatusCards();
      closeOverlay("ovInsightDdd");
      setActiveNav("leads");
      loadLeads(true).then(function(){ toast("ok", "Filtro aplicado", "Mostrando apenas leads da região " + ddd + "."); }).catch(function(e){ toast("err", "Filtro", e.message || "Falha ao aplicar filtro."); });
    }

    async function applyInsightDddTag(tagId){
      var ids = insightDddSelectedLeadIds();
      if (!ids.length) { toast("warn", "Tag", "Selecione pelo menos um lead."); return; }
      if (!tagId) { toast("warn", "Tag", "Selecione ou crie uma tag."); return; }
      var r = await fetch(API_BASE + "/leads/bulk-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: ids, addTagIds: [tagId] })
      });
      var j = await r.json().catch(function(){ return {}; });
      if (!r.ok || !j.ok) throw new Error(j.error || "Erro ao aplicar tag.");
      return j;
    }

    async function createAndApplyInsightDddTag(){
      var nameEl = document.getElementById("insDddNewTagName");
      var colorEl = document.getElementById("insDddNewTagColor");
      var name = (nameEl ? nameEl.value : "").trim();
      var color = colorEl ? colorEl.value : "#1a73e8";
      if (!name) { toast("warn", "Tag", "Digite o nome da nova tag."); return; }
      var r = await fetch(API_BASE + "/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, color: color })
      });
      var j = await r.json().catch(function(){ return {}; });
      if (!r.ok || !j.ok || !j.item) throw new Error(j.error || "Erro ao criar tag.");
      await fetchTags();
      await applyInsightDddTag(j.item.id);
      if (nameEl) nameEl.value = "";
      toast("ok", "Tag aplicada", "Tag criada e aplicada nos leads selecionados.");
      await loadInsights();
      openInsightDddModal(selectedInsightDdd);
    }

    function bindInsightDddModalActions(){
      var selectAll = document.getElementById("insDddSelectAll");
      if (selectAll) selectAll.addEventListener("change", function(){ setInsightDddSelection(selectAll.checked); });
      var exportBtn = document.getElementById("btnInsDddExport");
      if (exportBtn) exportBtn.addEventListener("click", downloadInsightDddCsv);
      var copyBtn = document.getElementById("btnInsDddCopyPhones");
      if (copyBtn) copyBtn.addEventListener("click", copyInsightDddPhones);
      var filterBtn = document.getElementById("btnInsDddFilterLeads");
      if (filterBtn) filterBtn.addEventListener("click", filterLeadPanelByInsightDdd);
      var applyBtn = document.getElementById("btnInsDddApplyTag");
      if (applyBtn) applyBtn.addEventListener("click", async function(){
        var sel = document.getElementById("insDddTagSelect");
        var tagId = sel ? sel.value : "";
        applyBtn.disabled = true;
        try{
          var out = await applyInsightDddTag(tagId);
          toast("ok", "Tag aplicada", "Tag aplicada em " + insFmt(out.updated || 0) + " lead(s).");
          await loadInsights();
          openInsightDddModal(selectedInsightDdd);
        }catch(e){ toast("err", "Tag", e.message || "Erro ao aplicar tag."); }
        finally{ applyBtn.disabled = false; }
      });
      var createBtn = document.getElementById("btnInsDddCreateApplyTag");
      if (createBtn) createBtn.addEventListener("click", async function(){
        createBtn.disabled = true;
        try{ await createAndApplyInsightDddTag(); }
        catch(e){ toast("err", "Tag", e.message || "Erro ao criar tag."); }
        finally{ createBtn.disabled = false; }
      });
    }

    async function copyInsightText(text){
      var value = String(text || "");
      if (!value.trim()) {
        toast("warn", "Copiar", "Não há conteúdo para copiar.");
        return;
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(value);
        else {
          var ta = document.createElement("textarea");
          ta.value = value;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        toast("ok", "Copiado", "Os dados foram copiados para a área de transferência.");
      } catch(e){
        toast("err", "Copiar", e && e.message ? e.message : String(e));
      }
    }

    function bindInsightCopyButtons(){
      var wrap = document.getElementById("panelInsights") || document;
      wrap.querySelectorAll("[data-insight-copy]").forEach(function(btn){
        if (btn.getAttribute("data-copy-bound") === "1") return;
        btn.setAttribute("data-copy-bound", "1");
        btn.addEventListener("click", function(){ copyInsightText(btn.getAttribute("data-insight-copy") || ""); });
      });
    }
    function renderDispatchStatusPill(row){
      var cls = row && row.statusClass ? row.statusClass : 'pending';
      var label = row && row.statusLabel ? row.statusLabel : 'Sem status';
      return '<span class="dispatchStatusPill ' + escapeHtml(cls) + '">' + escapeHtml(label) + '</span>';
    }

    var selectedDispatchCampaignId = "";

    function dispatchCampaignKey(c){
      return String((c && (c.id || c.campaignId)) || "");
    }

    function dispatchRowUpdatedAt(row){
      return row && (row.updatedAt || row.respondedAt || row.readAt || row.deliveredAt || row.sentAt || row.createdAt || "");
    }

    function renderDispatchInsights(dispatch){
      dispatch = dispatch || {};
      var campaigns = Array.isArray(dispatch.campaigns) ? dispatch.campaigns : [];
      var hasSelected = campaigns.some(function(c){ return dispatchCampaignKey(c) === selectedDispatchCampaignId; });
      if (!campaigns.length) selectedDispatchCampaignId = "";
      else if (!selectedDispatchCampaignId || !hasSelected) selectedDispatchCampaignId = String(dispatch.selectedCampaignId || dispatchCampaignKey(campaigns[0]) || "");

      var selected = campaigns.find(function(c){ return dispatchCampaignKey(c) === selectedDispatchCampaignId; }) || null;
      var s = selected ? (selected.metrics || {}) : (dispatch.summary || {});
      function set(id, value){ var el = document.getElementById(id); if (el) el.textContent = value; }
      set('insDispatchTotal', insFmt(s.total || 0));
      set('insDispatchSent', insFmt(s.sent || 0));
      set('insDispatchDelivered', insFmt(s.delivered || 0));
      set('insDispatchRead', insFmt(s.read || 0));
      set('insDispatchResponded', insFmt(s.responded || 0));
      set('insDispatchFailed', insFmt(s.failed || 0));
      set('insDispatchDeliveryRate', insPct(s.deliveryRate || 0) + ' de entrega');
      set('insDispatchReadRate', insPct(s.readRate || 0) + ' de leitura');
      set('insDispatchResponseRate', insPct(s.responseRate || 0) + ' de resposta');
      set('insDispatchFailureRate', insPct(s.failureRate || 0) + ' de falha');

      var selectedEl = document.getElementById('insDispatchSelected');
      if (selectedEl) {
        if (selected) {
          selectedEl.innerHTML = '<div><b>' + escapeHtml(selected.name || selected.templateName || 'Disparo oficial') + '</b><span>' + escapeHtml([selected.templateName || '', selected.languageCode || '', insDate(selected.createdAt || selected.updatedAt)].filter(Boolean).join(' · ')) + '</span></div><div class="dispatchSelectedTag"><i class="ph ph-target"></i> Visualizando só este disparo</div>';
        } else {
          selectedEl.innerHTML = '<div><b>Nenhum disparo oficial encontrado</b><span>Assim que uma campanha for enviada, ela aparecerá aqui com estatísticas próprias.</span></div><div class="dispatchSelectedTag"><i class="ph ph-info"></i> Aguardando dados</div>';
        }
      }

      var ctx = selected ? (selected.context || {}) : (dispatch.context || {});
      var ctxEl = document.getElementById('insDispatchContext');
      if (ctxEl) {
        ctxEl.innerHTML = [
          '<span class="dispatchContextPill"><i class="ph ph-paper-plane-tilt"></i> Disparos: ' + insFmt(campaigns.length || 0) + '</span>',
          '<span class="dispatchContextPill"><i class="ph ph-plug"></i> Webhook: ' + insFmt(ctx.webhookImpacted || 0) + '</span>',
          '<span class="dispatchContextPill"><i class="ph ph-table"></i> Só planilha: ' + insFmt(ctx.spreadsheetOnly || 0) + '</span>',
          '<span class="dispatchContextPill"><i class="ph ph-git-merge"></i> Jornadas mistas: ' + insFmt(ctx.mixedJourney || 0) + '</span>' + ((ctx.legacyEvents || 0) ? '<span class="dispatchContextPill"><i class="ph ph-clock-counter-clockwise"></i> Histórico antigo: ' + insFmt(ctx.legacyEvents || 0) + '</span>' : '')
        ].join('');
      }

      var campEl = document.getElementById('insDispatchCampaigns');
      if (campEl) {
        campEl.innerHTML = campaigns.length ? '<div class="dispatchCampaignSelector">' + campaigns.map(function(c){
          var m = c.metrics || {};
          var key = dispatchCampaignKey(c);
          var active = key === selectedDispatchCampaignId ? ' active' : '';
          var meta = [c.templateName || '', c.languageCode || '', insDate(c.createdAt || c.updatedAt)].filter(Boolean).join(' · ');
          return '<button type="button" class="dispatchCampaignCard' + active + '" data-dispatch-campaign-select="' + escapeHtml(key) + '"><div><b>' + escapeHtml(c.name || c.templateName || 'Disparo oficial') + '</b><small>' + escapeHtml(meta || 'Campanha oficial') + '</small></div><span class="dispatchCampaignCount">' + insFmt(m.total || 0) + '</span><div class="dispatchRateMini"><span>Entregues ' + insFmt(m.delivered || 0) + '</span><span>Lidos ' + insFmt(m.read || 0) + '</span><span>Resp. ' + insFmt(m.responded || 0) + '</span><span>Falhas ' + insFmt(m.failed || 0) + '</span></div></button>';
        }).join('') + '</div>' : '<div class="dispatchEmpty">Ainda não há disparos oficiais registrados. Os próximos envios aparecerão aqui automaticamente.</div>';
        campEl.querySelectorAll('[data-dispatch-campaign-select]').forEach(function(btn){
          btn.addEventListener('click', function(){
            selectedDispatchCampaignId = btn.getAttribute('data-dispatch-campaign-select') || '';
            renderDispatchInsights(dispatch);
          });
        });
      }

      var origins = selected && Array.isArray(selected.origins) ? selected.origins : [];
      var originEl = document.getElementById('insDispatchOrigins');
      if (originEl) {
        originEl.innerHTML = origins.length ? '<div class="dispatchTableWrap"><table class="dispatchTable"><thead><tr><th>Origem</th><th>Impactados</th><th>Resultado</th></tr></thead><tbody>' + origins.map(function(o){
          var m = o.metrics || {};
          return '<tr><td class="dispatchNameCell"><b>' + escapeHtml(o.label || 'Origem') + '</b><span>' + escapeHtml(o.detail || o.type || '') + '</span></td><td><b>' + insFmt(m.total || 0) + '</b><div class="insightSourceDetail">' + insPct(m.responseRate || 0) + ' resposta</div></td><td><div class="dispatchRateMini"><span>Entregues ' + insFmt(m.delivered || 0) + '</span><span>Lidos ' + insFmt(m.read || 0) + '</span><span>Resp. ' + insFmt(m.responded || 0) + '</span><span>Falhas ' + insFmt(m.failed || 0) + '</span></div></td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="dispatchEmpty">Este disparo ainda não tem origem de contatos identificada.</div>';
      }

      var recent = selected && Array.isArray(selected.recent) ? selected.recent : [];
      var recentEl = document.getElementById('insDispatchRecent');
      if (recentEl) {
        recentEl.innerHTML = recent.length ? '<div class="dispatchTableWrap scrollable"><table class="dispatchTable"><thead><tr><th>Contato</th><th>Origem</th><th>Status</th><th>Atualização</th><th>Ação</th></tr></thead><tbody>' + recent.map(function(r){
          var digits = String(r.whatsapp_digits || '').replace(/\D+/g, '');
          var name = r.nome || formatWhatsAppPretty(digits) || 'Contato';
          var originBadge = '<span class="dispatchOriginBadge' + (r.mixedJourney ? ' mixed' : '') + '">' + escapeHtml(r.originLabel || 'Origem') + '</span>';
          var btnHtml = digits ? '<button class="btn btnSoft insightChatBtn" type="button" data-insight-chat="' + escapeHtml(digits) + '" data-insight-name="' + escapeHtml(r.nome || '') + '" data-insight-company="' + escapeHtml(r.empresa || '') + '" data-insight-email="' + escapeHtml(r.email || '') + '"><i class="ph ph-chat-circle-text"></i> Conversar</button>' : '<span class="hint">Sem WhatsApp</span>';
          return '<tr><td class="dispatchNameCell"><b>' + escapeHtml(name) + '</b><span>' + escapeHtml([r.empresa, formatWhatsAppPretty(digits)].filter(Boolean).join(' · ')) + '</span></td><td>' + originBadge + (r.dispatchSourceLabel ? '<div class="insightSourceDetail">Disparo: ' + escapeHtml(r.dispatchSourceLabel) + '</div>' : '') + '</td><td>' + renderDispatchStatusPill(r) + renderFriendlyDispatchError(r) + '</td><td>' + escapeHtml(insDate(dispatchRowUpdatedAt(r))) + '</td><td>' + btnHtml + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="dispatchEmpty">Nenhum evento registrado neste disparo.</div>';
      }
    }

    function renderInsights(data){
      insightsCache = data || {};
      var s = data.summary || {};
      var w = data.whatsapp || {};
      document.getElementById("insTotalLeads").textContent = insFmt(s.totalLeads);
      document.getElementById("insUniqueWhatsapp").textContent = insFmt(s.uniqueWhatsapp);
      document.getElementById("insConversations").textContent = insFmt(s.conversations);
      document.getElementById("insMessages").textContent = insFmt(s.totalMessages);
      var upd = document.getElementById("insightsUpdatedAt");
      if (upd) upd.textContent = "Atualizado: " + insDate(data.generatedAt);

      var statusRows = [
        { cls:"green", label:"Responderam", value:w.replied, hint:"Resposta real após envio · " + insPct(w.repliedRate) },
        { cls:"blue", label:"Receberam", value:w.delivered, hint:"Entregue sem resposta" },
        { cls:"red", label:"Não receberam", value:w.notDelivered, hint:"Erro ou prazo vencido · " + insPct(w.notDeliveredRate) },
        { cls:"yellow", label:"Não existem", value:w.notExists, hint:"Sem WhatsApp registrado · " + insPct(w.notExistsRate) },
        { cls:"gray", label:"Pendentes", value:w.pending, hint:"Aguardando ACK ou prazo" },
        { cls:"gray", label:"Sem envio", value:w.none, hint:"Sem status de mensagem" },
      ];
      document.getElementById("insWhatsappStatus").innerHTML = statusRows.map(function(r){
        return '<div class="insightStatus"><span class="insightStatusDot ' + r.cls + '"></span><div><b>' + insFmt(r.value) + '</b><small>' + escapeHtml(r.label + ' · ' + r.hint) + '</small></div></div>';
      }).join('');

      renderDispatchInsights(data.dispatch || {});

      var origins = Array.isArray(data.origins) ? data.origins : [];
      if (!origins.length) document.getElementById("insOrigins").innerHTML = insEmpty("Ainda não há origem suficiente para analisar.");
      else document.getElementById("insOrigins").innerHTML = '<div class="insightTableWrap scroll"><table class="insightTable"><thead><tr><th>Origem</th><th>Leads</th><th>Detalhe</th></tr></thead><tbody>' + origins.map(function(o){
        var msgHtml = (Array.isArray(o.messages) && o.messages.length) ? '<div class="insightLinkedMessage"><i class="ph ph-chat-text"></i><div><b>Mensagem vinculada</b><br>' + escapeHtml(insShort(o.messages.join(' | '), 170)) + '</div></div>' : '';
        var originLabel = insCompactOriginLabel(o.label || o.key, o.detail || '');
        return '<tr><td><div class="insightOriginName"><span class="insightOriginIcon"><i class="ph ph-flow-arrow"></i></span><div><div class="insightOriginTitle" title="' + escapeHtml(o.label || o.key || '') + '">' + escapeHtml(originLabel) + '</div><div class="insightOriginType">' + escapeHtml(o.type || '') + '</div></div></div></td><td><b>' + insFmt(o.count) + '</b><div class="insightSourceDetail">' + insPct(o.percentage) + '</div></td><td><div class="insightOriginDetailClean">' + escapeHtml(insCleanOriginDetail(o.detail || '—')) + '</div>' + msgHtml + '<div class="insightSourceDetail">Primeiro: ' + escapeHtml(insDate(o.firstAt)) + ' · Último: ' + escapeHtml(insDate(o.lastAt)) + '</div></td></tr>';
      }).join('') + '</tbody></table></div>';

      renderInsightTimeline(timelineRowsForCurrentRange());

      if (selectedInsightDdd && !(data.ddds || []).some(function(x){ return insightDddKey(x) === String(selectedInsightDdd) || String(x.ddd || "") === String(selectedInsightDdd); })) selectedInsightDdd = "";
      renderInsightDdds(data.ddds || []);

      var tags = Array.isArray(data.tags) ? data.tags : [];
      document.getElementById("insTags").innerHTML = tags.length ? tags.map(function(t){
        return '<span class="insightTagPill"><span class="insightTagDot" style="background:' + safeCssColor(t.color, '#64748b') + '"></span>' + escapeHtml(t.name || t.id) + ' · ' + insFmt(t.count) + '</span>';
      }).join('') : insEmpty("Nenhuma tag atribuída ainda.");

      var conv = data.conversations && Array.isArray(data.conversations.top) ? data.conversations.top : [];
      document.getElementById("insConversationsBox").innerHTML = conv.length ? '<div class="insightTableWrap scroll"><table class="insightTable"><thead><tr><th>Contato</th><th>Mensagens</th><th>Última</th><th>Ações</th></tr></thead><tbody>' + conv.map(function(c){
        var digits = String(c.whatsapp_digits || "").replace(/\D+/g, "");
        var name = c.nome || formatWhatsAppPretty(digits);
        var btnHtml = digits ? '<button class="btn btnSoft insightChatBtn" type="button" data-insight-chat="' + escapeHtml(digits) + '" data-insight-name="' + escapeHtml(c.nome || '') + '" data-insight-company="' + escapeHtml(c.empresa || '') + '"><i class="ph ph-chat-circle-text"></i> Conversar</button>' : '<span class="hint">Sem WhatsApp</span>';
        return '<tr><td><div class="insightLeadCell">' + renderInsightLeadStatusDot(c.status) + '<div class="insightLeadCellMain"><b>' + escapeHtml(name) + '</b><div class="insightSourceDetail">' + escapeHtml(c.empresa || digits || '') + '</div></div></div></td><td><b>' + insFmt(c.total) + '</b><div class="insightSourceDetail">Entrada: ' + insFmt(c.incoming) + ' · Saída: ' + insFmt(c.outgoing) + ' · Mídia: ' + insFmt(c.media) + '</div></td><td>' + escapeHtml(insDate(c.lastAt)) + '<div class="insightSourceDetail">' + escapeHtml(insShort(c.lastPreview, 80)) + '</div></td><td>' + btnHtml + '</td></tr>';
      }).join('') + '</tbody></table></div>' : insEmpty("Nenhuma conversa real salva ainda.");

      var crm = data.crm && Array.isArray(data.crm.pipelines) ? data.crm.pipelines : [];
      document.getElementById("insCrm").innerHTML = crm.length ? '<div class="insightFunnelWrap">' + crm.map(function(p, pi){
        var stages = Array.isArray(p.stages) ? p.stages : [];
        var maxCount = Math.max.apply(null, stages.map(function(st){ return Number(st.count || 0); }).concat([1]));
        var stageHtml = stages.length ? stages.map(function(st, si){
          var totalStages = Math.max(1, stages.length - 1);
          var width = Math.max(46, 100 - ((si / totalStages) * 42));
          var empty = Number(st.count || 0) ? '' : ' empty';
          var rate = maxCount ? Math.round((Number(st.count || 0) / maxCount) * 100) : 0;
          return '<button class="insightFunnelStage' + empty + '" type="button" style="--stage-w:' + width + '%" data-ins-crm-pipeline="' + pi + '" data-ins-crm-stage="' + si + '"><div><div class="insightFunnelStageName">' + escapeHtml(st.name || 'Etapa') + '</div><div class="insightFunnelStageMeta">' + insFmt(st.count || 0) + ' lead(s) · ' + rate + '% do maior volume deste funil</div></div><div class="insightFunnelCount">' + insFmt(st.count || 0) + '</div></button>';
        }).join('') : insEmpty("Sem etapas.");
        return '<div class="insightFunnelPanel"><div class="insightFunnelHead"><div><b>' + escapeHtml(p.name || 'Funil') + '</b><span>Leads distribuídos conforme a etapa atual no CRM.</span></div><span class="hint">' + insFmt(p.total || 0) + ' card(s)</span></div><div class="insightFunnelShape">' + stageHtml + '</div></div>';
      }).join('') + '</div>' : insEmpty("Nenhum funil configurado ainda.");
      bindInsightCrmStageButtons();

      var webhooks = Array.isArray(data.webhooks) ? data.webhooks : [];
      document.getElementById("insWebhooks").innerHTML = webhooks.length ? '<div class="insightTableWrap scroll"><table class="insightTable"><thead><tr><th>Webhook</th><th>Leads</th><th>Mensagens</th><th>Atualização</th><th>Ação</th></tr></thead><tbody>' + webhooks.map(function(wb, wi){
        var msgs = Array.isArray(wb.messages) ? wb.messages : [];
        var leadCount = Number(wb.leadCount || 0);
        var leadDetail = leadCount ? '<div class="insightSourceDetail">' + insPct(wb.leadPercentage) + ' da base · Último lead: ' + escapeHtml(insDate(wb.lastLeadAt)) + '</div>' : '<div class="insightSourceDetail">Nenhum lead registrado ainda.</div>';
        var whName = insCompactOriginLabel(wb.displayName || wb.name || 'Webhook', wb.urlPreview || '');
        var msgHtml = msgs.length ? msgs.map(function(m){ return '<div class="insightLinkedMessage"><i class="ph ph-chat-text"></i><div>' + escapeHtml(insShort(m, 150)) + '</div></div>'; }).join('') : '<span class="hint">Sem mensagem automática vinculada.</span>';
        var action = '<button class="btn btnSoft" type="button" data-ins-webhook-index="' + wi + '"><i class="ph ph-users-three"></i> Ver leads</button>';
        return '<tr><td><b class="insightWebhookName" title="' + escapeHtml(wb.displayName || wb.name || '') + '">' + escapeHtml(whName) + '</b><div class="insightSourceDetail">' + escapeHtml(insCompactUrl(wb.urlPreview || '')) + '</div></td><td><b>' + insFmt(leadCount) + '</b>' + leadDetail + '</td><td>' + msgHtml + '</td><td>' + escapeHtml(insDate(wb.updatedAt || wb.createdAt)) + '</td><td>' + action + '</td></tr>';
      }).join('') + '</tbody></table></div>' : insEmpty("Nenhum webhook ativo criado.");
      bindInsightWebhookButtons();

      var recent = Array.isArray(data.recentLeads) ? data.recentLeads : [];
      document.getElementById("insRecentLeads").innerHTML = recent.length ? '<div style="overflow:auto;"><table class="insightTable"><thead><tr><th>Lead</th><th>Origem</th><th>Tags</th><th>Data</th><th>Ações</th></tr></thead><tbody>' + recent.map(function(l){
        var tagHtml = Array.isArray(l.tags) && l.tags.length ? l.tags.map(function(t){ return '<span class="insightTagPill"><span class="insightTagDot" style="background:' + safeCssColor(t.color, '#64748b') + '"></span>' + escapeHtml(t.name || t.id) + '</span>'; }).join('') : '<span class="hint">—</span>';
        var digits = String(l.whatsapp_digits || l.whatsapp_raw || '').replace(/\D+/g, '');
        var btnHtml = digits ? '<button class="btn btnSoft insightChatBtn" type="button" data-insight-chat="' + escapeHtml(digits) + '" data-insight-name="' + escapeHtml(l.nome || '') + '" data-insight-company="' + escapeHtml(l.empresa || '') + '" data-insight-email="' + escapeHtml(l.email || '') + '"><i class="ph ph-chat-circle-text"></i> Conversar</button>' : '<span class="hint">Sem WhatsApp</span>';
        return '<tr><td><b>' + escapeHtml(l.nome || formatWhatsAppPretty(l.whatsapp_digits) || 'Lead') + '</b><div class="insightSourceDetail">' + escapeHtml([l.empresa,l.email].filter(Boolean).join(' · ')) + '</div></td><td><b>' + escapeHtml(l.originLabel || l.source || 'Origem') + '</b><div class="insightSourceDetail">' + escapeHtml(l.originDetail || '') + '</div></td><td>' + tagHtml + '</td><td>' + escapeHtml(insDate(l.createdAt)) + '</td><td>' + btnHtml + '</td></tr>';
      }).join('') + '</tbody></table></div>' : insEmpty("Ainda não há leads recentes.");
      bindInsightChatButtons();
      bindInsightCopyButtons();

      var pill = document.getElementById("navInsightsPill");
      if (pill) pill.textContent = insFmt(s.totalLeads || 0);
    }

    function bindInsightTimelineControls(){
      var buttons = document.querySelectorAll("[data-ins-timeline-range]");
      buttons.forEach(function(btn){
        if (btn.getAttribute("data-ins-range-bound") === "1") return;
        btn.setAttribute("data-ins-range-bound", "1");
        btn.addEventListener("click", function(){
          insightTimelineRange = btn.getAttribute("data-ins-timeline-range") || "30";
          buttons.forEach(function(b){ b.classList.toggle("active", b === btn); });
          renderInsightTimeline(timelineRowsForCurrentRange());
        });
      });
      var customBtn = document.getElementById("btnInsTimelineCustom");
      if (customBtn && customBtn.getAttribute("data-ins-custom-bound") !== "1") {
        customBtn.setAttribute("data-ins-custom-bound", "1");
        customBtn.addEventListener("click", function(){
          var from = document.getElementById("insTimelineFrom");
          var to = document.getElementById("insTimelineTo");
          if (!from || !to || !from.value || !to.value) {
            toast("warn", "Período personalizado", "Escolha a data inicial e final.");
            return;
          }
          if (from.value > to.value) {
            toast("warn", "Período personalizado", "A data inicial não pode ser maior que a final.");
            return;
          }
          insightTimelineRange = "custom";
          buttons.forEach(function(b){ b.classList.remove("active"); });
          renderInsightTimeline(timelineRowsForCurrentRange());
        });
      }
    }

    function bindInsightWebhookButtons(){
      var wrap = document.getElementById("insWebhooks");
      if (!wrap) return;
      wrap.querySelectorAll("[data-ins-webhook-index]").forEach(function(btn){
        if (btn.getAttribute("data-ins-webhook-bound") === "1") return;
        btn.setAttribute("data-ins-webhook-bound", "1");
        btn.addEventListener("click", function(){
          var idx = Number(btn.getAttribute("data-ins-webhook-index") || -1);
          var rows = insightsCache && Array.isArray(insightsCache.webhooks) ? insightsCache.webhooks : [];
          var wb = rows[idx];
          if (!wb) return;
          openInsightListModal("Leads do webhook", (wb.displayName || wb.name || "Webhook") + " · " + insFmt((wb.leads || []).length) + " lead(s)", Array.isArray(wb.leads) ? wb.leads : []);
        });
      });
    }

    function bindInsightCrmStageButtons(){
      var wrap = document.getElementById("insCrm");
      if (!wrap) return;
      wrap.querySelectorAll("[data-ins-crm-pipeline][data-ins-crm-stage]").forEach(function(btn){
        if (btn.getAttribute("data-ins-crm-bound") === "1") return;
        btn.setAttribute("data-ins-crm-bound", "1");
        btn.addEventListener("click", function(){
          var pi = Number(btn.getAttribute("data-ins-crm-pipeline") || -1);
          var si = Number(btn.getAttribute("data-ins-crm-stage") || -1);
          var pipelines = insightsCache && insightsCache.crm && Array.isArray(insightsCache.crm.pipelines) ? insightsCache.crm.pipelines : [];
          var p = pipelines[pi];
          var st = p && Array.isArray(p.stages) ? p.stages[si] : null;
          if (!st) return;
          openInsightListModal("Etapa: " + (st.name || "Etapa"), (p.name || "Funil") + " · " + insFmt(st.count || 0) + " lead(s)", Array.isArray(st.leads) ? st.leads : []);
        });
      });
    }

    function bindInsightListModalActions(){
      var closeBtn = document.getElementById("btnCloseInsightList");
      if (closeBtn && closeBtn.getAttribute("data-ins-list-close-bound") !== "1") {
        closeBtn.setAttribute("data-ins-list-close-bound", "1");
        closeBtn.addEventListener("click", closeInsightListModal);
      }
      var ov = document.getElementById("ovInsightList");
      if (ov && ov.getAttribute("data-ins-list-overlay-bound") !== "1") {
        ov.setAttribute("data-ins-list-overlay-bound", "1");
        ov.addEventListener("click", function(ev){ if (ev.target === ov) closeInsightListModal(); });
      }
    }

    async function loadInsights(){
      var btn = document.getElementById("btnInsightsRefresh");
      if (btn) btn.disabled = true;
      try {
        var res = await fetch(API_BASE + "/insights?notDeliveredAfterMin=30", { credentials:"same-origin" });
        var data = await res.json();
        if (!res.ok || data.ok === false) throw new Error(data.error || "Falha ao carregar insights.");
        renderInsights(data);
      } catch(e){
        toast("err", "Insights", e && e.message ? e.message : String(e));
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    var btnInsightsRefresh = document.getElementById("btnInsightsRefresh");
    if (btnInsightsRefresh) btnInsightsRefresh.addEventListener("click", loadInsights);
    bindInsightTimelineControls();
    bindInsightListModalActions();
    bindInsightDddModalActions();

    function insightNormalizeDigits(value){
      return String(value || "").replace(/\D+/g, "");
    }

    function bindInsightChatButtons(){
      var wrap = document.getElementById("panelInsights") || document;
      wrap.querySelectorAll("[data-insight-chat]").forEach(function(btn){
        if (btn.getAttribute("data-chat-bound") === "1") return;
        btn.setAttribute("data-chat-bound", "1");
        btn.addEventListener("click", function(){
          openConversationFromInsight({
            whatsapp_digits: btn.getAttribute("data-insight-chat") || "",
            nome: btn.getAttribute("data-insight-name") || "",
            empresa: btn.getAttribute("data-insight-company") || "",
            email: btn.getAttribute("data-insight-email") || ""
          });
        });
      });
    }

    async function openConversationFromInsight(contact){
      var digits = insightNormalizeDigits(contact && contact.whatsapp_digits);
      if (!digits){
        toast("warn", "Conversa", "Este lead não tem WhatsApp cadastrado.");
        return;
      }
      try {
        var search = document.getElementById("chatSearch");
        if (search) search.value = digits;
        setActiveNav("chats");
        await loadConversations({ keepSelected: false });
        var targetVariants = phoneSearchVariantsClient(digits);
        var found = chatContacts.find(function(x){
          var candidateVariants = phoneSearchVariantsClient(x.whatsapp_digits || x.whatsapp_raw);
          return targetVariants.some(function(v){ return candidateVariants.indexOf(v) >= 0; });
        });
        if (!found) {
          found = {
            id: "lead_" + digits,
            nome: contact.nome || "",
            empresa: contact.empresa || "",
            email: contact.email || "",
            whatsapp_digits: digits,
            whatsapp_raw: digits,
            isLead: true,
            isNewConversationOnly: false
          };
          chatContacts.unshift(found);
          renderChatList();
        }
        await openConversation(found);
      } catch(e){
        toast("err", "Conversa", e && e.message ? e.message : String(e));
      }
    }

    /* ---------- Conversas ---------- */
    var chatContacts = [];
    var chatSelected = null;
    var chatRefreshTimer = null;
    var chatLoading = false;
    var chatMessagesCache = [];
    var chatRecorder = null;
    var chatRecorderStream = null;
    var chatRecorderChunks = [];
    var chatAudioBlob = null;
    var chatAudioMime = "";
    var chatAudioUrl = "";
    var chatRecordStartedAt = 0;
    var chatRecordDurationSeconds = 0;
    var chatRecordTimer = null;
    var chatAudioContext = null;
    var chatAudioAnalyser = null;
    var chatWaveRaf = null;
    var chatWaveData = null;
    var chatRegisterCatalog = { ok:false, configured:false, pipelines:[], queue:{}, error:"" };
    var chatRegisterCatalogLoading = false;
    var chatRegisterSubmitting = false;

    function chatInitials(name){
      var parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return "?";
      return (parts[0][0] || "?").toUpperCase() + (parts[1] ? (parts[1][0] || "").toUpperCase() : "");
    }

    function chatSub(contact){
      var pieces = [];
      if (contact.empresa) pieces.push(contact.empresa);
      if (contact.email) pieces.push(contact.email);
      var base = pieces.join(" • ") || formatWhatsAppPretty(contact.whatsapp_digits || contact.whatsapp_raw || "");
      if (contact && contact.isNewConversationOnly) return "Número novo • " + base;
      return base;
    }

    function chatLastTime(contact){
      var iso = contact && (contact.lastActivity || contact.createdAt);
      if (!iso) return "";
      try {
        var d = new Date(iso);
        if (isNaN(d)) return "";
        return d.toLocaleDateString("pt-BR", { day:"2-digit", month:"2-digit" });
      } catch(e){ return ""; }
    }

    function chatMessagePreview(message){
      if (!message) return "Clique para carregar o histórico";
      var isAudio = message.mediaKind === "audio" || message.type === "audio" || message.type === "ptt";
      var body = String(message.body || "").trim();
      var label = isAudio ? "Áudio" : (body || "Mensagem");
      return (message.fromMe ? "Você: " : "") + label;
    }

    function chatContactStatusValue(contact){
      var serverStatus = contact && (contact.conversationStatus || contact.chatStatus);
      var st = serverStatus ? String(serverStatus || "") : leadStatusValue(contact);
      var last = contact && contact.lastMessage;
      if ((st === "none" || !st) && last && last.fromMe === false) return "replied";
      return st || "none";
    }

    function chatContactStatusLabel(contact){
      var st = chatContactStatusValue(contact);
      var map = {
        replied: "Respondeu",
        delivered: "Recebeu",
        pending: "Pendente",
        notDelivered: "Não recebeu",
        notExists: "Não existe",
        none: "Sem envio"
      };
      return map[st] || "Sem envio";
    }

    function renderChatList(){
      var el = document.getElementById("chatList");
      var hint = document.getElementById("chatListHint");
      if (!el) return;
      if (hint) {
        var filterEl = document.querySelector("[data-chat-status-filter].active");
        var filterVal = filterEl ? String(filterEl.getAttribute("data-chat-status-filter") || "active") : "active";
        var filterText = filterVal === "active" ? "receberam ou responderam" : filterVal === "replied" ? "responderam" : filterVal === "delivered" ? "receberam" : "todos os status";
        hint.textContent = chatContacts.length ? (chatContacts.length + " conversa(s) encontrada(s) • " + filterText) : ("Nenhuma conversa encontrada • " + filterText);
      }
      var pill = document.getElementById("navChatsCount");
      if (pill) pill.textContent = chatContacts.length ? String(chatContacts.length) : "0";

      if (!chatContacts.length){
        el.innerHTML = '<div class="chatEmpty"><div class="chatEmptyBox"><b>Nenhuma conversa encontrada</b><br><span>Nenhum contato encontrado para o filtro selecionado. Por padrão, aparecem só quem recebeu ou respondeu.</span></div></div>';
        return;
      }

      var html = chatContacts.map(function(c){
        var digits = String(c.whatsapp_digits || c.whatsapp_raw || "").replace(/\D+/g, "");
        var selected = chatSelected && String(chatSelected.whatsapp_digits || "") === digits;
        var preview = chatMessagePreview(c.lastMessage);
        var unread = Number(c.unreadCount || 0);
        var statusValue = chatContactStatusValue(c);
        var statusLabel = chatContactStatusLabel(c);
        return '<button class="conversationItem ' + (selected ? 'active' : '') + '" type="button" data-chat-digits="' + escapeHtml(digits) + '" title="Status: ' + escapeHtml(statusLabel) + '">' +
          '<div class="chatAvatarWrap">' +
            '<div class="chatAvatar">' + escapeHtml(chatInitials(c.nome)) + '</div>' +
            '<span class="chatStatusDot status-' + escapeHtml(statusValue) + '" aria-label="' + escapeHtml(statusLabel) + '"></span>' +
          '</div>' +
          '<div style="min-width:0;">' +
            '<div class="chatName">' + escapeHtml(c.nome || formatWhatsAppPretty(digits)) + '</div>' +
            '<div class="chatMeta">' + escapeHtml(chatSub(c)) + '</div>' +
            '<div class="chatPreview">' + escapeHtml(preview) + '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">' +
            '<small class="hint">' + escapeHtml(chatLastTime(c)) + '</small>' +
            '<span class="chatStatusText status-' + escapeHtml(statusValue) + '">' + escapeHtml(statusLabel) + '</span>' +
            (unread ? '<span class="chatBadge">' + unread + '</span>' : '') +
          '</div>' +
        '</button>';
      }).join("");
      el.innerHTML = html;
      el.querySelectorAll("[data-chat-digits]").forEach(function(btn){
        btn.addEventListener("click", function(){
          var digits = btn.getAttribute("data-chat-digits");
          var found = chatContacts.find(function(x){ return String(x.whatsapp_digits || "") === digits; });
          if (found) openConversation(found);
        });
      });
    }

    async function loadConversations(opts){
      opts = opts || {};
      var q = String((document.getElementById("chatSearch") || {}).value || "").trim();
      var statusFilterEl = document.querySelector("[data-chat-status-filter].active");
      var statusFilter = statusFilterEl ? String(statusFilterEl.getAttribute("data-chat-status-filter") || "active") : "active";
      var url = API_BASE + "/conversations?limit=1000" + (q ? ("&q=" + encodeURIComponent(q)) : "") + (statusFilter && statusFilter !== "all" ? ("&status=" + encodeURIComponent(statusFilter)) : "");
      var list = document.getElementById("chatList");
      if (list && !opts.keepSelected) list.innerHTML = '<div class="chatLoadState">Carregando conversas...</div>';
      try{
        var r = await fetch(url);
        var j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || "Falha ao carregar conversas.");
        chatContacts = Array.isArray(j.items) ? j.items : [];
        if (chatSelected){
          var currentDigits = String(chatSelected.whatsapp_digits || "");
          var updated = chatContacts.find(function(x){ return String(x.whatsapp_digits || "") === currentDigits; });
          if (updated) chatSelected = updated;
        }
        renderChatList();
      }catch(e){
        if (list) list.innerHTML = '<div class="chatEmpty"><div class="chatEmptyBox"><b>Não consegui carregar as conversas</b><br><span>' + escapeHtml(e.message || e) + '</span></div></div>';
      }
    }

    function formatMediaBytes(value){
      var n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return "";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace(".0", "") + " KB";
      return (n / (1024 * 1024)).toFixed(1).replace(".0", "") + " MB";
    }

    function mediaIcon(kind){
      var map = { pdf:"ph-file-pdf", document:"ph-file-doc", spreadsheet:"ph-file-xls", presentation:"ph-presentation-chart", archive:"ph-file-zip", text:"ph-file-text", image:"ph-image", video:"ph-video", audio:"ph-waveform" };
      return map[kind] || "ph-file";
    }

    function renderChatMedia(m, body){
      var kind = String(m.mediaKind || "file").toLowerCase();
      var mediaUrl = m.mediaUrl ? safeUrlForMarkup(m.mediaUrl, { sameOrigin:true }) : "";
      var downloadUrl = m.mediaDownloadUrl ? safeUrlForMarkup(m.mediaDownloadUrl, { sameOrigin:true }) : mediaUrl;
      var name = escapeHtml(m.mediaName || m.originalName || m.filename || body || "Arquivo");
      var size = escapeHtml(formatMediaBytes(m.mediaSize));
      if (m.mediaUnavailable || !mediaUrl){
        return '<div class="msgMediaUnavailable"><i class="ph ph-warning-circle"></i> Esta mídia não está disponível no servidor.</div>';
      }
      if (kind === "audio"){
        return '<div class="msgAudioTitle"><i class="ph ph-waveform"></i><span>' + escapeHtml(body || "Áudio") + '</span></div>' +
          '<audio class="msgAudioPlayer" controls preload="metadata" src="' + mediaUrl + '"></audio>';
      }
      if (kind === "image"){
        return '<img class="msgMediaImage" loading="lazy" alt="' + name + '" src="' + mediaUrl + '">' +
          '<div class="msgMediaActions"><a class="msgMediaLink" href="' + downloadUrl + '"><i class="ph ph-download-simple"></i> Baixar</a></div>';
      }
      if (kind === "video"){
        return '<video class="msgMediaVideo" controls preload="metadata" src="' + mediaUrl + '"></video>' +
          '<div class="msgMediaActions"><a class="msgMediaLink" href="' + downloadUrl + '"><i class="ph ph-download-simple"></i> Baixar</a></div>';
      }
      var openLink = kind === "pdf" ? '<a class="msgMediaLink" target="_blank" rel="noopener" href="' + mediaUrl + '"><i class="ph ph-eye"></i> Abrir PDF</a>' : '';
      return '<div class="msgMediaCard"><div class="msgMediaCardIcon"><i class="ph ' + mediaIcon(kind) + '"></i></div>' +
        '<div class="msgMediaCardMain"><b>' + name + '</b><span>' + escapeHtml(kind) + (size ? ' · ' + size : '') + '</span>' +
        '<div class="msgMediaActions">' + openLink + '<a class="msgMediaLink" href="' + downloadUrl + '"><i class="ph ph-download-simple"></i> Baixar</a></div></div></div>';
    }

    function renderChatMessages(messages){
      var box = document.getElementById("chatMessages");
      if (!box) return;
      chatMessagesCache = Array.isArray(messages) ? messages.slice() : [];
      if (!messages || !messages.length){
        box.innerHTML = '<div class="chatEmpty"><div class="chatEmptyBox"><b>Nenhuma mensagem encontrada</b><br><span>Envie texto, áudio ou arquivo para começar.</span></div></div>';
        return;
      }
      box.innerHTML = messages.map(function(m){
        var date = m.createdAt ? formatDate(m.createdAt) : "";
        var body = String(m.body || "").trim();
        var hasMedia = Boolean(m.hasMedia || m.mediaId || m.mediaUrl || m.mediaUnavailable);
        var content = hasMedia ? renderChatMedia(m, body) : escapeHtml(body || "");
        if (hasMedia && body && !["audio"].includes(String(m.mediaKind || "").toLowerCase())) {
          content += '<div class="hint" style="margin-top:7px;">' + escapeHtml(body) + '</div>';
        }
        return '<div class="msgRow ' + (m.fromMe ? 'me' : 'them') + '">' +
          '<div class="msgBubble">' + content + '<div class="msgTime">' + escapeHtml(date) + '</div></div>' +
        '</div>';
      }).join("");
      box.scrollTop = box.scrollHeight;
    }


    function chatRegisterPipelineById(id){
      var wanted = String(id || "");
      var pipelines = Array.isArray(chatRegisterCatalog.pipelines) ? chatRegisterCatalog.pipelines : [];
      return pipelines.find(function(p){ return String(p.id || "") === wanted; }) || null;
    }

    function populateChatRegisterStages(pipelineId, selectedStageId){
      var stageEl = document.getElementById("chatRegisterCrmStage");
      if (!stageEl) return;
      var wanted = String(selectedStageId || "");
      stageEl.innerHTML = "";

      if (!pipelineId){
        var defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = "Etapa “Novo lead” padrão";
        stageEl.appendChild(defaultOption);
        stageEl.value = "";
        stageEl.disabled = false;
        return;
      }

      var pipeline = chatRegisterPipelineById(pipelineId);
      var stages = pipeline && Array.isArray(pipeline.stages) ? pipeline.stages : [];
      stages.forEach(function(stage){
        var option = document.createElement("option");
        option.value = String(stage.id || "");
        option.textContent = String(stage.name || "Etapa");
        stageEl.appendChild(option);
      });
      if (!stages.length){
        var fallback = document.createElement("option");
        fallback.value = "";
        fallback.textContent = "Etapa padrão do funil";
        stageEl.appendChild(fallback);
      }
      stageEl.value = wanted || (stages[0] ? String(stages[0].id || "") : "");
    }

    function populateChatRegisterPipelines(){
      var pipelineEl = document.getElementById("chatRegisterCrmPipeline");
      if (!pipelineEl) return;
      var pipelines = Array.isArray(chatRegisterCatalog.pipelines) ? chatRegisterCatalog.pipelines : [];
      pipelineEl.innerHTML = "";

      var defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "Funil padrão do CRM";
      pipelineEl.appendChild(defaultOption);

      pipelines.forEach(function(pipeline){
        var option = document.createElement("option");
        option.value = String(pipeline.id || "");
        option.textContent = String(pipeline.name || "Funil") + (pipeline.isDefault ? " · padrão" : "");
        pipelineEl.appendChild(option);
      });

      var preferred = String(chatRegisterCatalog.defaultPipelineId || "");
      if (!preferred){
        var defaultPipeline = pipelines.find(function(p){ return Boolean(p && p.isDefault); });
        preferred = defaultPipeline ? String(defaultPipeline.id || "") : "";
      }
      pipelineEl.value = preferred;
      populateChatRegisterStages(preferred, "");
    }

    function renderChatRegisterCrmState(){
      var checkbox = document.getElementById("chatRegisterExternalCrm");
      var fields = document.getElementById("chatRegisterCrmFields");
      var status = document.getElementById("chatRegisterCrmStatus");
      var submit = document.getElementById("chatRegisterSubmit");
      var enabled = Boolean(checkbox && checkbox.checked && !checkbox.disabled);

      if (fields) fields.classList.toggle("is-disabled", !enabled);
      if (submit) submit.innerHTML = enabled
        ? '<i class="ph ph-user-plus"></i> Cadastrar nos dois sistemas'
        : '<i class="ph ph-user-plus"></i> Cadastrar no Bob.IA';
      if (!status) return;

      status.className = "chatRegisterCrmStatus";
      if (chatRegisterCatalogLoading){
        status.innerHTML = '<i class="ph ph-spinner-gap"></i> Consultando o CRM Inteligente...';
        return;
      }
      if (!chatRegisterCatalog.configured){
        status.classList.add("err");
        status.innerHTML = '<i class="ph ph-warning-circle"></i> CRM Inteligente não configurado. O cadastro poderá ser feito somente no Bob.IA.';
        return;
      }
      if (!chatRegisterCatalog.ok){
        status.classList.add("warn");
        status.innerHTML = '<i class="ph ph-warning"></i> Integração configurada, mas o catálogo não respondeu. O funil padrão será usado e o envio ficará na fila segura.';
        return;
      }
      var queue = chatRegisterCatalog.queue || {};
      var pending = Number(queue.pending || 0) + Number(queue.sending || 0);
      status.classList.add("ok");
      status.innerHTML = '<i class="ph ph-check-circle"></i> CRM conectado' + (pending ? ' · ' + pending + ' item(ns) na fila' : ' · fila sem pendências') + '.';
    }

    async function loadChatRegisterCrmCatalog(){
      if (chatRegisterCatalogLoading) return chatRegisterCatalog;
      chatRegisterCatalogLoading = true;
      renderChatRegisterCrmState();
      try{
        var response = await fetch(API_BASE + "/external-crm/catalog");
        var data = await response.json().catch(function(){ return {}; });
        chatRegisterCatalog = {
          ok: Boolean(response.ok && data && data.ok !== false),
          configured: Boolean(data && data.configured),
          pipelines: data && Array.isArray(data.pipelines) ? data.pipelines : [],
          queue: data && data.queue ? data.queue : {},
          defaultPipelineId: data && data.defaultPipelineId ? String(data.defaultPipelineId) : "",
          error: data && (data.error || data.message) ? String(data.error || data.message) : "",
        };
      }catch(error){
        chatRegisterCatalog = {
          ok:false,
          configured:Boolean(chatRegisterCatalog.configured),
          pipelines:Array.isArray(chatRegisterCatalog.pipelines) ? chatRegisterCatalog.pipelines : [],
          queue:chatRegisterCatalog.queue || {},
          defaultPipelineId:String(chatRegisterCatalog.defaultPipelineId || ""),
          error:error && error.message ? error.message : String(error),
        };
      }finally{
        chatRegisterCatalogLoading = false;
      }

      var checkbox = document.getElementById("chatRegisterExternalCrm");
      if (checkbox){
        checkbox.disabled = !chatRegisterCatalog.configured;
        checkbox.checked = Boolean(chatRegisterCatalog.configured);
      }
      populateChatRegisterPipelines();
      renderChatRegisterCrmState();
      return chatRegisterCatalog;
    }

    function openChatRegisterModal(){
      if (!chatSelected) return;
      if (chatSelected.isLead || !chatSelected.isNewConversationOnly){
        toast("warn", "Contato já cadastrado", "Este número já faz parte da lista de leads.");
        return;
      }

      var digits = String(chatSelected.whatsapp_digits || chatSelected.whatsapp_raw || "").replace(/\D+/g, "");
      document.getElementById("chatRegisterNome").value = String(chatSelected.nome || "").trim();
      document.getElementById("chatRegisterWhatsapp").value = formatWhatsAppPretty(digits);
      document.getElementById("chatRegisterEmail").value = String(chatSelected.email || "").trim();
      document.getElementById("chatRegisterEmpresa").value = String(chatSelected.empresa || "").trim();
      document.getElementById("chatRegisterWebsite").value = String(chatSelected.website || "").trim();
      document.getElementById("chatRegisterTags").value = "WhatsApp, contato novo";
      document.getElementById("chatRegisterCrmSource").value = "WhatsApp";
      var checkbox = document.getElementById("chatRegisterExternalCrm");
      if (checkbox){ checkbox.disabled = false; checkbox.checked = true; }
      openOverlay("ovChatRegister");
      renderChatRegisterCrmState();
      loadChatRegisterCrmCatalog();
      setTimeout(function(){ document.getElementById("chatRegisterNome")?.focus(); }, 30);
    }

    async function submitChatRegister(){
      if (!chatSelected || chatRegisterSubmitting) return;
      var nome = String((document.getElementById("chatRegisterNome") || {}).value || "").trim();
      if (!nome){
        toast("warn", "Nome obrigatório", "Informe o nome do contato para concluir o cadastro.");
        document.getElementById("chatRegisterNome")?.focus();
        return;
      }

      var digits = String(chatSelected.whatsapp_digits || chatSelected.whatsapp_raw || "").replace(/\D+/g, "");
      var syncCheckbox = document.getElementById("chatRegisterExternalCrm");
      var syncExternalCrm = Boolean(syncCheckbox && syncCheckbox.checked && !syncCheckbox.disabled);
      var submit = document.getElementById("chatRegisterSubmit");
      chatRegisterSubmitting = true;
      if (submit){ submit.disabled = true; submit.innerHTML = '<i class="ph ph-spinner-gap"></i> Cadastrando...'; }

      try{
        var response = await fetch(API_BASE + "/conversations/" + encodeURIComponent(digits) + "/register", {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body:JSON.stringify({
            nome:nome,
            email:String((document.getElementById("chatRegisterEmail") || {}).value || "").trim(),
            empresa:String((document.getElementById("chatRegisterEmpresa") || {}).value || "").trim(),
            website:String((document.getElementById("chatRegisterWebsite") || {}).value || "").trim(),
            tags:String((document.getElementById("chatRegisterTags") || {}).value || "").trim(),
            syncExternalCrm:syncExternalCrm,
            externalCrmTarget:{
              pipelineId:String((document.getElementById("chatRegisterCrmPipeline") || {}).value || ""),
              stageId:String((document.getElementById("chatRegisterCrmStage") || {}).value || ""),
              source:String((document.getElementById("chatRegisterCrmSource") || {}).value || "WhatsApp"),
            }
          })
        });
        var data = await response.json().catch(function(){ return {}; });
        if (!response.ok || !data.ok) throw new Error(data.error || "Não foi possível cadastrar este contato.");

        var updatedContact = Object.assign({}, chatSelected, data.contact || {}, data.lead || {}, {
          isLead:true,
          isNewConversationOnly:false,
        });
        chatSelected = updatedContact;
        chatContacts = chatContacts.map(function(item){
          var itemDigits = String(item.whatsapp_digits || item.whatsapp_raw || "").replace(/\D+/g, "");
          return itemDigits === digits ? Object.assign({}, item, updatedContact) : item;
        });
        setChatHeader(chatSelected);
        renderChatList();
        closeOverlay("ovChatRegister");

        var crmOk = syncExternalCrm && data.externalCrm && (data.externalCrm.queued || data.externalCrm.duplicate || data.externalCrm.status === "delivered");
        toast("ok", "Contato cadastrado", crmOk
          ? "O lead foi salvo no Bob.IA e registrado na fila do CRM Inteligente."
          : "O lead foi salvo no Bob.IA.", 6000);
        await loadConversations({ keepSelected:true });
        if (chatSelected) setChatHeader(chatSelected);
      }catch(error){
        toast("err", "Falha no cadastro", error && error.message ? error.message : String(error), 7000);
      }finally{
        chatRegisterSubmitting = false;
        if (submit) submit.disabled = false;
        renderChatRegisterCrmState();
      }
    }

    function setChatHeader(contact){
      var title = document.getElementById("chatHeaderTitle");
      var sub = document.getElementById("chatHeaderSub");
      var av = document.getElementById("chatHeaderAvatar");
      var input = document.getElementById("chatText");
      var send = document.getElementById("chatSend");
      var record = document.getElementById("chatRecordAudio");
      var attach = document.getElementById("chatAttach");
      var registerBtn = document.getElementById("chatRegisterContact");
      var unknownContact = Boolean(contact && !contact.isLead);
      if (title) title.textContent = contact ? (contact.nome || formatWhatsAppPretty(contact.whatsapp_digits)) : "Selecione uma conversa";
      if (sub) sub.textContent = contact ? (formatWhatsAppPretty(contact.whatsapp_digits || contact.whatsapp_raw) + (contact.empresa ? " • " + contact.empresa : "") + (unknownContact ? " • Número ainda não cadastrado" : "")) : "Escolha um contato da lista para carregar mensagens e áudios.";
      if (registerBtn) registerBtn.style.display = unknownContact ? "inline-flex" : "none";
      if (av) av.textContent = contact ? chatInitials(contact.nome) : "?";
      if (input) input.disabled = !contact;
      if (send) send.disabled = !contact;
      if (record) record.disabled = !contact;
      if (attach) attach.disabled = !contact;
    }

    async function openConversation(contact){
      clearChatAudioDraft();
      chatMessagesCache = [];
      chatSelected = contact;
      setChatHeader(contact);
      renderChatList();
      await loadConversationMessages();
      startChatAutoRefresh();
    }

    async function loadConversationMessages(){
      if (!chatSelected || chatLoading) return;
      chatLoading = true;
      var box = document.getElementById("chatMessages");
      if (box && !chatMessagesCache.length) box.innerHTML = '<div class="chatLoadState">Carregando histórico de mensagens...</div>';
      try{
        var digits = String(chatSelected.whatsapp_digits || "").replace(/\D+/g, "");
        var r = await fetch(API_BASE + "/conversations/" + encodeURIComponent(digits) + "/messages?limit=80");
        var j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || "Falha ao carregar mensagens.");
        if (j.contact && chatSelected){
          chatSelected = Object.assign({}, chatSelected, j.contact);
          setChatHeader(chatSelected);
        }
        renderChatMessages(j.messages || []);
      }catch(e){
        if (box) box.innerHTML = '<div class="chatEmpty"><div class="chatEmptyBox"><b>Não consegui abrir esta conversa</b><br><span>' + escapeHtml(e.message || e) + '</span><br><br><span>Confirme se o WhatsApp Web está conectado pelo painel.</span></div></div>';
      }finally{
        chatLoading = false;
      }
    }

    async function sendChatText(){
      if (!chatSelected) return;
      var input = document.getElementById("chatText");
      var send = document.getElementById("chatSend");
      var text = String(input && input.value || "").trim();
      if (!text){ toast("warn", "Mensagem vazia", "Digite uma mensagem antes de enviar."); return; }
      if (send) send.disabled = true;
      try{
        var digits = String(chatSelected.whatsapp_digits || "").replace(/\D+/g, "");
        var r = await fetch(API_BASE + "/conversations/" + encodeURIComponent(digits) + "/messages", {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ text: text })
        });
        var j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || "Falha ao enviar mensagem.");
        if (input) input.value = "";
        if (j.message) {
          chatMessagesCache = chatMessagesCache.concat([j.message]);
          renderChatMessages(chatMessagesCache);
          if (chatSelected) {
            chatSelected.lastMessage = j.message;
            chatSelected.lastActivity = j.message.createdAt || new Date().toISOString();
          }
        }
        loadConversations({ keepSelected:true });
        setTimeout(function(){ loadConversationMessages(); }, 900);
      }catch(e){
        toast("err", "Erro ao enviar", e.message || String(e), 5000);
      }finally{
        if (send) send.disabled = !chatSelected;
      }
    }

    function ensureChatWaveBars(){
      var wave = document.getElementById("chatAudioWave");
      if (!wave) return;
      if (wave.children.length >= 28) return;
      var html = "";
      for (var i=0;i<32;i++) html += "<span></span>";
      wave.innerHTML = html;
    }

    function setWaveIdle(level){
      ensureChatWaveBars();
      var wave = document.getElementById("chatAudioWave");
      if (!wave) return;
      var bars = wave.querySelectorAll("span");
      bars.forEach(function(bar, i){
        var base = level || 0;
        var n = Math.abs(Math.sin((i + 1) * .75)) * 16 + 6;
        var h = base ? Math.max(6, Math.min(28, n * base)) : (6 + (i % 5) * 2);
        bar.style.height = h.toFixed(0) + "px";
        bar.style.opacity = base ? String(Math.min(.95, .45 + base)) : ".35";
      });
    }

    function stopChatWaveform(){
      if (chatWaveRaf) cancelAnimationFrame(chatWaveRaf);
      chatWaveRaf = null;
      if (chatAudioContext) {
        try { chatAudioContext.close(); } catch(e) {}
      }
      chatAudioContext = null;
      chatAudioAnalyser = null;
      chatWaveData = null;
    }

    function startChatWaveform(stream){
      stopChatWaveform();
      ensureChatWaveBars();
      try{
        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) { setWaveIdle(.4); return; }
        chatAudioContext = new AudioCtx();
        var source = chatAudioContext.createMediaStreamSource(stream);
        chatAudioAnalyser = chatAudioContext.createAnalyser();
        chatAudioAnalyser.fftSize = 128;
        chatWaveData = new Uint8Array(chatAudioAnalyser.frequencyBinCount);
        source.connect(chatAudioAnalyser);
        function draw(){
          if (!chatAudioAnalyser || !chatWaveData) return;
          chatAudioAnalyser.getByteFrequencyData(chatWaveData);
          var sum = 0;
          for (var i=0;i<chatWaveData.length;i++) sum += chatWaveData[i];
          var avg = sum / Math.max(1, chatWaveData.length);
          var level = Math.max(.25, Math.min(1.8, avg / 55));
          setWaveIdle(level);
          chatWaveRaf = requestAnimationFrame(draw);
        }
        draw();
      }catch(e){
        setWaveIdle(.5);
      }
    }

    function formatAudioTime(total){
      total = Math.max(0, Math.floor(Number(total || 0)));
      var mm = String(Math.floor(total / 60)).padStart(2, "0");
      var ss = String(total % 60).padStart(2, "0");
      return mm + ":" + ss;
    }

    function setAudioRecordingUi(state){
      var rec = document.getElementById("chatRecordAudio");
      var stop = document.getElementById("chatStopAudio");
      var sendAudio = document.getElementById("chatSendAudio");
      var cancel = document.getElementById("chatCancelAudio");
      var panel = document.getElementById("chatAudioPanel");
      var hint = document.getElementById("chatRecordingHint");
      var preview = document.getElementById("chatAudioPreview");
      var hasContact = Boolean(chatSelected);

      if (rec){
        rec.disabled = !hasContact;
        rec.classList.toggle("recording", state === "recording");
        rec.title = state === "recording" ? "Parar gravação" : "Gravar áudio";
        rec.setAttribute("aria-label", state === "recording" ? "Parar gravação" : "Gravar áudio");
        rec.innerHTML = state === "recording" ? '<i class="ph ph-stop-circle"></i>' : '<i class="ph ph-microphone"></i>';
      }
      if (panel) panel.classList.toggle("isVisible", state === "recording" || state === "ready");
      if (stop) stop.style.display = state === "recording" ? "inline-flex" : "none";
      if (sendAudio) sendAudio.style.display = state === "ready" ? "inline-flex" : "none";
      if (cancel) cancel.style.display = state === "recording" || state === "ready" ? "inline-flex" : "none";
      if (preview) preview.style.display = state === "ready" && chatAudioUrl ? "block" : "none";
      if (hint){
        if (state === "recording") hint.innerHTML = '<span class="audioRecordingDot"></span><span id="chatRecordingClock">Gravando 00:00</span>';
        else if (state === "ready") hint.innerHTML = '<span class="audioRecordingDot" style="background:#34A853;box-shadow:0 0 0 4px rgba(52,168,83,.12);"></span><span id="chatRecordingClock">Pronto ' + formatAudioTime(chatRecordDurationSeconds) + '</span>';
        else hint.innerHTML = '<span class="audioRecordingDot"></span><span id="chatRecordingClock">00:00</span>';
      }
      if (state === "ready") setWaveIdle(.75);
      if (state === "idle") setWaveIdle(0);
    }

    function clearChatAudioDraft(){
      if (chatRecorder && chatRecorder.state !== "inactive") {
        try { chatRecorder.stop(); } catch(e) {}
      }
      if (chatRecorderStream) {
        chatRecorderStream.getTracks().forEach(function(track){ try { track.stop(); } catch(e) {} });
      }
      stopChatWaveform();
      if (chatAudioUrl) URL.revokeObjectURL(chatAudioUrl);
      if (chatRecordTimer) clearInterval(chatRecordTimer);
      chatRecorder = null;
      chatRecorderStream = null;
      chatRecorderChunks = [];
      chatAudioBlob = null;
      chatAudioMime = "";
      chatAudioUrl = "";
      chatRecordStartedAt = 0;
      chatRecordDurationSeconds = 0;
      chatRecordTimer = null;
      var preview = document.getElementById("chatAudioPreview");
      if (preview){ preview.removeAttribute("src"); preview.load(); }
      setAudioRecordingUi("idle");
    }

    function preferredAudioMime(){
      var candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/ogg"
      ];
      if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
      for (var i=0;i<candidates.length;i++){
        if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
      }
      return "";
    }

    function updateRecordingClock(){
      var el = document.getElementById("chatRecordingClock");
      if (!el || !chatRecordStartedAt) return;
      var total = Math.max(0, Math.floor((Date.now() - chatRecordStartedAt) / 1000));
      chatRecordDurationSeconds = total;
      el.textContent = "Gravando " + formatAudioTime(total);
    }

    async function startChatAudioRecording(){
      if (chatRecorder && chatRecorder.state === "recording") { stopChatAudioRecording(); return; }
      if (!chatSelected){ toast("warn", "Selecione uma conversa", "Escolha um contato antes de gravar áudio."); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder){
        toast("err", "Gravação indisponível", "Seu navegador não liberou gravação de áudio nesta página.", 5000);
        return;
      }
      clearChatAudioDraft();
      try{
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        var mime = preferredAudioMime();
        var opts = mime ? { mimeType: mime } : undefined;
        chatRecorderStream = stream;
        chatRecorderChunks = [];
        chatRecorder = new MediaRecorder(stream, opts);
        chatAudioMime = chatRecorder.mimeType || mime || "audio/webm";
        chatRecorder.ondataavailable = function(e){ if (e.data && e.data.size) chatRecorderChunks.push(e.data); };
        chatRecorder.onstop = function(){
          if (chatRecorderStream) chatRecorderStream.getTracks().forEach(function(track){ try { track.stop(); } catch(e) {} });
          chatRecorderStream = null;
          stopChatWaveform();
          if (chatRecordTimer) clearInterval(chatRecordTimer);
          chatRecordTimer = null;
          if (chatRecordStartedAt) chatRecordDurationSeconds = Math.max(1, Math.floor((Date.now() - chatRecordStartedAt) / 1000));
          if (!chatRecorderChunks.length){ clearChatAudioDraft(); return; }
          chatAudioBlob = new Blob(chatRecorderChunks, { type: chatAudioMime || "audio/webm" });
          chatAudioUrl = URL.createObjectURL(chatAudioBlob);
          var preview = document.getElementById("chatAudioPreview");
          if (preview && setSafeElementUrl(preview, "src", chatAudioUrl, { allowBlob: true, allowDataAudio: true })){ preview.load(); }
          setAudioRecordingUi("ready");
        };
        chatRecorder.start(250);
        chatRecordStartedAt = Date.now();
        chatRecordDurationSeconds = 0;
        setAudioRecordingUi("recording");
        startChatWaveform(stream);
        updateRecordingClock();
        chatRecordTimer = setInterval(updateRecordingClock, 250);
      }catch(e){
        clearChatAudioDraft();
        toast("err", "Microfone não liberado", e.message || String(e), 5000);
      }
    }

    function stopChatAudioRecording(){
      if (!chatRecorder || chatRecorder.state === "inactive") return;
      try { chatRecorder.stop(); } catch(e) { toast("err", "Erro ao parar gravação", e.message || String(e)); }
    }

    function uploadMimeForFile(file){
      var current = String(file && file.type || "").split(";")[0].toLowerCase();
      if (current) return current;
      var name = String(file && file.name || "").toLowerCase();
      var map = { ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".png":"image/png", ".webp":"image/webp", ".gif":"image/gif", ".ogg":"audio/ogg", ".opus":"audio/ogg", ".webm":"video/webm", ".mp3":"audio/mpeg", ".m4a":"audio/mp4", ".aac":"audio/aac", ".wav":"audio/wav", ".mp4":"video/mp4", ".mov":"video/quicktime", ".pdf":"application/pdf", ".txt":"text/plain", ".csv":"text/csv", ".doc":"application/msword", ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xls":"application/vnd.ms-excel", ".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".ppt":"application/vnd.ms-powerpoint", ".pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation", ".zip":"application/zip" };
      var ext = Object.keys(map).find(function(item){ return name.endsWith(item); });
      return ext ? map[ext] : "";
    }

    async function sendChatAudio(){
      if (!chatSelected || !chatAudioBlob){ toast("warn", "Nenhum áudio", "Grave um áudio antes de enviar."); return; }
      var btn = document.getElementById("chatSendAudio");
      var micBtn = document.getElementById("chatRecordAudio");
      if (btn) btn.disabled = true;
      if (micBtn) micBtn.disabled = true;
      try{
        var digits = String(chatSelected.whatsapp_digits || "").replace(/\D+/g, "");
        if (!digits) throw new Error("Selecione uma conversa válida antes de enviar áudio.");
        var mime = String(chatAudioBlob.type || chatAudioMime || "audio/webm").split(";")[0] || "audio/webm";
        var ext = /ogg/i.test(mime) ? "ogg" : (/mpeg|mp3/i.test(mime) ? "mp3" : (/mp4|aac/i.test(mime) ? "m4a" : "webm"));
        var r = await fetch(API_BASE + "/conversations/" + encodeURIComponent(digits) + "/audio", {
          method:"POST",
          headers:{ "Content-Type":mime, "X-Zape-Filename":encodeURIComponent("audio." + ext) },
          body:chatAudioBlob
        });
        var raw = await r.text();
        var j = null;
        try { j = raw ? JSON.parse(raw) : null; } catch(parseErr) {}
        if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || raw || "Não consegui enviar este áudio.");
        if (j.message){
          chatMessagesCache = chatMessagesCache.concat([j.message]);
          renderChatMessages(chatMessagesCache);
          if (chatSelected){ chatSelected.lastMessage = j.message; chatSelected.lastActivity = j.message.createdAt || new Date().toISOString(); }
        }
        clearChatAudioDraft();
        loadConversations({ keepSelected:true });
        setTimeout(function(){ loadConversationMessages(); }, 900);
      }catch(e){
        toast("err", "Erro ao enviar áudio", e.message || String(e), 7000);
      }finally{
        if (btn) btn.disabled = false;
        if (micBtn) micBtn.disabled = false;
      }
    }

    async function sendChatAttachment(file){
      if (!chatSelected || !file) return;
      var mime = uploadMimeForFile(file);
      if (!mime){ toast("err", "Tipo não permitido", "Este formato de arquivo não é aceito.", 5000); return; }
      if (file.size > 25 * 1024 * 1024){ toast("err", "Arquivo muito grande", "Envie um arquivo de até 25 MB.", 5000); return; }
      var button = document.getElementById("chatAttach");
      var input = document.getElementById("chatAttachmentInput");
      if (button) button.disabled = true;
      try{
        var digits = String(chatSelected.whatsapp_digits || "").replace(/\D+/g, "");
        var captionEl = document.getElementById("chatText");
        var caption = String(captionEl && captionEl.value || "").trim();
        var r = await fetch(API_BASE + "/conversations/" + encodeURIComponent(digits) + "/attachments", {
          method:"POST",
          headers:{ "Content-Type":mime, "X-Zape-Filename":encodeURIComponent(file.name || "arquivo"), "X-Zape-Caption":encodeURIComponent(caption.slice(0,1000)) },
          body:file
        });
        var raw = await r.text();
        var j = null;
        try { j = raw ? JSON.parse(raw) : null; } catch(e) {}
        if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || raw || "Falha ao enviar arquivo.");
        if (captionEl && caption) captionEl.value = "";
        if (j.message){ chatMessagesCache = chatMessagesCache.concat([j.message]); renderChatMessages(chatMessagesCache); }
        loadConversations({ keepSelected:true });
      }catch(e){
        toast("err", "Erro ao enviar arquivo", e.message || String(e), 7000);
      }finally{
        if (input) input.value = "";
        if (button) button.disabled = !chatSelected;
      }
    }


    function startChatAutoRefresh(){
      stopChatAutoRefresh();
      if (!navChats || !navChats.classList.contains("active")) return;
      chatRefreshTimer = setInterval(function(){
        if (!navChats || !navChats.classList.contains("active")) return stopChatAutoRefresh();
        if (chatSelected) loadConversationMessages();
        loadConversations({ keepSelected:true });
      }, 6000);
    }

    function stopChatAutoRefresh(){
      if (chatRefreshTimer) clearInterval(chatRefreshTimer);
      chatRefreshTimer = null;
    }

    (function wireConversations(){
      var q = document.getElementById("chatSearch");
      var timer = null;
      if (q) q.addEventListener("input", function(){
        clearTimeout(timer);
        timer = setTimeout(function(){ loadConversations({ keepSelected:true }); }, 250);
      });
      document.querySelectorAll("[data-chat-status-filter]").forEach(function(btn){
        btn.addEventListener("click", function(){
          document.querySelectorAll("[data-chat-status-filter]").forEach(function(other){ other.classList.remove("active"); });
          btn.classList.add("active");
          loadConversations({ keepSelected:false });
        });
      });
      document.getElementById("chatRefresh")?.addEventListener("click", function(){ loadConversations({ keepSelected:true }); if (chatSelected) loadConversationMessages(); });
      document.getElementById("chatReloadThread")?.addEventListener("click", loadConversationMessages);
      document.getElementById("chatRegisterContact")?.addEventListener("click", openChatRegisterModal);
      document.getElementById("chatRegisterCancel")?.addEventListener("click", function(){ closeOverlay("ovChatRegister"); });
      document.getElementById("chatRegisterSubmit")?.addEventListener("click", submitChatRegister);
      document.getElementById("chatRegisterExternalCrm")?.addEventListener("change", renderChatRegisterCrmState);
      document.getElementById("chatRegisterCrmPipeline")?.addEventListener("change", function(){ populateChatRegisterStages(this.value, ""); });
      document.getElementById("chatSend")?.addEventListener("click", sendChatText);
      document.getElementById("chatRecordAudio")?.addEventListener("click", startChatAudioRecording);
      document.getElementById("chatStopAudio")?.addEventListener("click", stopChatAudioRecording);
      document.getElementById("chatSendAudio")?.addEventListener("click", sendChatAudio);
      document.getElementById("chatCancelAudio")?.addEventListener("click", clearChatAudioDraft);
      document.getElementById("chatAttach")?.addEventListener("click", function(){ document.getElementById("chatAttachmentInput")?.click(); });
      document.getElementById("chatAttachmentInput")?.addEventListener("change", function(){ var file = this.files && this.files[0]; if (file) sendChatAttachment(file); });
      var textArea = document.getElementById("chatText");
      if (textArea) textArea.addEventListener("keydown", function(e){
        if (e.key === "Enter" && !e.shiftKey){
          e.preventDefault();
          sendChatText();
        }
      });
    })();

    /* ---------- WhatsApp Cloud API UI ---------- */
    var cloudContacts = [];
    var cloudTemplatesCache = [];
    var cloudTemplateActiveTab = "account";
    var cloudLibraryActiveCategory = "all";
    var cloudStatusCache = null;
    var cloudEmbeddedCode = "";
    var cloudEmbeddedSession = null;
    var cloudEmbeddedIds = { wabaId: "", phoneNumberId: "", businessId: "" };
    var cloudFbSdkPromise = null;
    var cloudFbSdkKey = "";

    function isFacebookOrigin(origin){
      try{
        var u = new URL(origin);
        return u.hostname === "facebook.com" || u.hostname === "www.facebook.com" || u.hostname === "web.facebook.com" || /\.facebook\.com$/.test(u.hostname);
      }catch(_){ return false; }
    }

    function setCloudEmbeddedLog(msg){
      var el = document.getElementById("cloudEmbeddedLog");
      if (el) el.textContent = String(msg || "");
    }

    function cloudCard(label, value, extraClass){
      return '<div class="cloudStatusCard ' + (extraClass || '') + '">' +
        '<div class="cloudStatusLabel">' + escapeHtml(label) + '</div>' +
        '<div class="cloudStatusValue">' + escapeHtml(value || '—') + '</div>' +
      '</div>';
    }

    function cloudFetch(url, options){
      return window.zapeApi.request(url, options || {});
    }

    function normalizeCloudApiError(status, payload, fallback){
      payload = payload || {};
      if (status === 401 && payload.login) {
        return "Sua sessão do painel expirou. Faça login novamente neste painel e tente de novo.";
      }
      if (payload.code === "META_TOKEN_INVALID") {
        return payload.error || "A conexão com a Meta foi invalidada. Vincule novamente o WhatsApp para gerar um novo token.";
      }
      if (payload.code === "META_WABA_TOKEN_MISMATCH") {
        return payload.error || "Token e WABA ID não pertencem à mesma conexão. Vincule novamente o WhatsApp pelo painel para atualizar a conexão.";
      }
      if (payload.code === "META_PANEL_CONNECTION_INCOMPLETE") {
        return payload.error || "A conexão do painel está incompleta. Vincule novamente o WhatsApp para salvar Token, WABA ID e Phone Number ID juntos.";
      }
      if (payload.errorInfo && payload.errorInfo.display) {
        return payload.errorInfo.display;
      }
      var base = payload.error || payload.message || fallback || "Falha na API.";
      var meta = payload.details && payload.details.error ? payload.details.error : null;
      if (meta && meta.message && String(meta.message) !== String(base)) {
        base += " | Meta: " + meta.message;
      }
      if (meta && meta.code) {
        base += " | Código: " + meta.code;
      }
      return base;
    }


    function cloudErrorSeverityClass(info){
      var sev = String(info && info.severity || '').toLowerCase();
      if (sev === 'error') return 'err';
      if (sev === 'success' || sev === 'ok') return 'ok';
      return 'warn';
    }

    function cloudErrorIcon(info){
      var cat = String(info && info.category || '').toLowerCase();
      if (cat.indexOf('modelo') >= 0) return 'ph-file-text';
      if (cat.indexOf('contato') >= 0 || cat.indexOf('entrega') >= 0) return 'ph-user-warning';
      if (cat.indexOf('limite') >= 0 || cat.indexOf('qualidade') >= 0) return 'ph-gauge';
      if (cat.indexOf('pagamento') >= 0) return 'ph-credit-card';
      if (cat.indexOf('autent') >= 0 || cat.indexOf('permiss') >= 0) return 'ph-key';
      if (cat.indexOf('registro') >= 0 || cat.indexOf('conta') >= 0) return 'ph-warning-octagon';
      return 'ph-warning-circle';
    }

    function renderCloudErrorGroup(group){
      group = group || {};
      var cls = cloudErrorSeverityClass(group);
      var code = group.code ? ' #' + group.code + (group.subcode ? '.' + group.subcode : '') : '';
      var steps = Array.isArray(group.nextSteps) ? group.nextSteps.slice(0, 4) : [];
      var examples = Array.isArray(group.examples) ? group.examples.filter(Boolean).slice(0, 5) : [];
      return '<div class="cloudErrorGroup ' + cls + '">' +
        '<div class="cloudErrorGroupTop"><div class="cloudErrorGroupTitle"><i class="ph ' + escapeHtml(cloudErrorIcon(group)) + '"></i><div><b>' + escapeHtml((group.title || 'Erro no envio') + code) + '</b><span>' + escapeHtml(group.category || 'Erro da Meta') + (group.retryable ? ' · Pode tentar novamente depois' : '') + '</span></div></div><span class="cloudErrorCount">' + escapeHtml(String(group.count || 0)) + ' ocorrência(s)</span></div>' +
        (group.cause ? '<p class="cloudErrorAction"><b>Causa provável:</b> ' + escapeHtml(group.cause) + '</p>' : '') +
        (group.action ? '<p class="cloudErrorAction"><b>O que fazer:</b> ' + escapeHtml(group.action) + '</p>' : '') +
        (steps.length ? '<ol class="cloudErrorSteps">' + steps.map(function(x){ return '<li>' + escapeHtml(x) + '</li>'; }).join('') + '</ol>' : '') +
        (examples.length ? '<div class="cloudErrorExamples">Exemplos: ' + escapeHtml(examples.join(', ')) + '</div>' : '') +
      '</div>';
    }

    function localCloudErrorInfo(raw){
      var msg = typeof raw === 'string' ? raw : (raw && (raw.error || raw.message || raw.originalMessage || raw.technicalMessage)) || '';
      var code = raw && raw.code ? Number(raw.code) : null;
      var m = String(msg || '').match(/#?(\d{3,7})/);
      if (!code && m) code = Number(m[1]);
      var base = { code: code || null, subcode: raw && raw.subcode ? raw.subcode : null, severity: 'warning', category: 'Erro da Meta', title: 'Erro no envio', cause: String(msg || 'Falha retornada pela Meta.'), action: 'Abra os detalhes técnicos e envie para análise.' };
      if (code === 133010 || /account.*not.*registered|not registered/i.test(msg)) return Object.assign(base, { severity:'error', category:'Conta/Registro', title:'Número remetente não registrado na Cloud API', cause:'O número oficial usado como remetente não está registrado corretamente na WhatsApp Business Platform/Cloud API. Isso normalmente não é erro do lead.', action:'Registre o número da empresa na Cloud API ou refaça o vínculo do WhatsApp oficial no painel com o WABA e Phone Number ID corretos.', nextSteps:['Conferir status do número no WhatsApp Manager','Registrar o número pela API /register se estiver pendente','Confirmar Phone Number ID correto','Refazer vínculo no painel'] });
      if (code === 131026) return Object.assign(base, { category:'Contato/Entrega', title:'Mensagem não pôde ser entregue ao contato', cause:'O número pode não ter WhatsApp, estar incorreto, ter bloqueado a empresa ou estar indisponível.', action:'Separe esses contatos e valide por outro canal.', nextSteps:['Conferir DDI/DDD','Testar contato manualmente','Marcar como sem entrega'] });
      if (code === 132001) return Object.assign(base, { severity:'error', category:'Modelo', title:'Modelo não existe ou idioma incorreto', cause:'O template não existe, não está aprovado ou foi chamado com idioma diferente.', action:'Atualize a lista de modelos e escolha um aprovado no idioma correto.', nextSteps:['Atualizar modelos','Escolher APPROVED','Conferir pt_BR ou idioma usado'] });
      if (code === 132012 || code === 132000) return Object.assign(base, { severity:'error', category:'Modelo', title:'Variáveis do modelo incompatíveis', cause:'As variáveis enviadas não batem com o modelo aprovado.', action:'Revise quantidade, ordem e preenchimento das variáveis.', nextSteps:['Conferir {{1}}, {{2}}','Mapear colunas da planilha','Testar uma linha'] });
      if (code === 130429 || code === 131048 || code === 131056 || /rate|throughput|too many/i.test(msg)) return Object.assign(base, { category:'Limite', title:'Limite de envio atingido', cause:'A Meta limitou volume, frequência ou mensagens para o mesmo contato.', action:'Reduza o ritmo de envio e divida a campanha em lotes.', nextSteps:['Aumentar throttle','Pausar alguns minutos','Retomar só falhas'] });
      if (code === 190 || /token|oauth/i.test(msg)) return Object.assign(base, { severity:'error', category:'Autenticação', title:'Token expirado ou inválido', cause:'A Meta recusou o token salvo.', action:'Refaça o vínculo do WhatsApp oficial.', nextSteps:['Desconectar','Conectar novamente','Atualizar modelos'] });
      return base;
    }

    function buildLocalCloudErrorGroups(results){
      var map = {};
      (Array.isArray(results) ? results : []).forEach(function(item){
        if (!item || item.ok) return;
        var info = item.errorInfo || localCloudErrorInfo(item.error || item);
        var key = (info.code || info.title || 'unknown') + '_' + (info.subcode || '');
        if (!map[key]) map[key] = Object.assign({}, info, { key:key, count:0, examples:[] });
        map[key].count += 1;
        if (map[key].examples.length < 5 && item.to) map[key].examples.push(item.to);
      });
      return Object.keys(map).map(function(k){ return map[k]; }).sort(function(a,b){ return (b.count||0)-(a.count||0); });
    }

    function renderCloudBatchResult(j, requestedTotal){
      j = j || {};
      var results = Array.isArray(j.results) ? j.results : [];
      var summary = j.summary || {};
      var sent = Number(summary.sent != null ? summary.sent : results.filter(function(x){ return x && x.ok; }).length);
      var failed = Number(summary.failed != null ? summary.failed : results.filter(function(x){ return x && !x.ok; }).length);
      var total = Number(summary.total || j.total || results.length || requestedTotal || 0);
      var groups = Array.isArray(summary.errorGroups) && summary.errorGroups.length ? summary.errorGroups : buildLocalCloudErrorGroups(results);
      var cls = failed ? 'warn' : 'ok';
      var html = '<div class="cloudResultCard ' + cls + '"><b>Campanha processada</b>' +
        '<p class="cloudHelp">O envio foi processado pelo servidor. Abaixo está a leitura operacional das falhas, sem depender do JSON técnico da Meta.</p>' +
        '<div class="cloudResultNumbers"><div><span>Total</span><b>' + escapeHtml(String(total)) + '</b></div><div><span>Enviados</span><b>' + escapeHtml(String(sent)) + '</b></div><div><span>Falhas</span><b>' + escapeHtml(String(failed)) + '</b></div></div>';
      if (groups.length) {
        html += '<div class="cloudErrorGroups">' + groups.map(renderCloudErrorGroup).join('') + '</div>';
      }
      var failedRows = results.filter(function(x){ return x && !x.ok; }).slice(0, 40);
      if (failedRows.length) {
        html += '<div class="cloudFailureTableWrap"><table class="cloudFailureTable"><thead><tr><th>Telefone</th><th>Erro identificado</th><th>Ação</th></tr></thead><tbody>' + failedRows.map(function(row){
          var info = row.errorInfo || localCloudErrorInfo(row.error || row);
          var code = info.code ? ' #' + info.code : '';
          return '<tr><td><b>' + escapeHtml(row.to || '') + '</b></td><td>' + escapeHtml((info.title || row.error || 'Erro') + code) + '<div class="hint">' + escapeHtml(info.cause || row.error || '') + '</div></td><td>' + escapeHtml(info.action || 'Ver retorno técnico.') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      }
      html += '<details class="cloudTechnicalDetails"><summary>Ver retorno técnico</summary><pre>' + escapeHtml(JSON.stringify(j, null, 2)) + '</pre></details></div>';
      return html;
    }

    function renderFriendlyDispatchError(row){
      var info = row && row.errorInfo ? row.errorInfo : (row && row.error ? localCloudErrorInfo(row.error) : null);
      if (!info) return '';
      var code = info.code ? ' #' + info.code : '';
      return '<div class="cloudFriendlyErrorMini"><b>' + escapeHtml((info.title || 'Erro') + code) + '</b><br>' + escapeHtml(info.action || info.cause || '') + '</div>';
    }

    function renderCloudConnectionStatus(){
      var el = document.getElementById("cloudConnectionStatus");
      var pill = document.getElementById("navCloudPill");
      if (!el) return;

      var st = cloudStatusCache || {};
      var es = st.embeddedSignup || {};
      var configured = !!st.configured;
      el.classList.add("cloudStatusPanel");

      var html = '';
      html += '<div class="cloudStatusCard main">' +
        '<div><div class="cloudStatusLabel">Conexão oficial com a Meta</div>' +
        '<div class="cloudStatusValue big">' + (configured ? 'Conectado' : 'Pendente de conexão') + '</div></div>' +
        '<span class="cloudStatusPill ' + (configured ? 'ok' : 'warn') + '">' +
          '<span class="statusDot ' + (configured ? 'replied' : 'notDelivered') + '"></span>' + (configured ? 'API oficial ativa' : 'Configuração pendente') +
        '</span>' +
      '</div>';
      html += cloudCard('Número', st.displayPhoneNumber || st.phoneNumberId || 'Ainda não vinculado');
      html += cloudCard('Nome verificado', st.verifiedName || '—');
      html += cloudCard('WABA ID', st.wabaId || '—');
      html += cloudCard('Phone Number ID', st.phoneNumberId || '—');
      html += cloudCard('Embedded Signup', es.configured ? 'Configurado' : 'Pendente');
      html += cloudCard('App ID', es.appId || '—');
      html += cloudCard('Configuration ID', es.configurationId || '—');
      html += cloudCard('Token salvo', st.tokenMasked || '—');
      if (st.linkedAt) html += cloudCard('Vinculado em', new Date(st.linkedAt).toLocaleString('pt-BR'));
      if (st.subscribedAt) html += cloudCard('Webhook WABA', 'Inscrito em ' + new Date(st.subscribedAt).toLocaleString('pt-BR'));
      if (st.lastSubscribeError && st.lastSubscribeError.message) {
        html += '<div class="cloudStatusCard cloudStatusWarning"><div class="cloudStatusLabel">Atenção no webhook</div><div class="cloudStatusValue">' + escapeHtml(st.lastSubscribeError.message) + '</div></div>';
      }
      if (es.appSecretMasked) html += cloudCard('App Secret', es.appSecretMasked);

      el.innerHTML = html;
      if (pill) pill.textContent = configured ? "OK" : "API";

      var appId = document.getElementById("cloudEmbeddedAppId");
      var configId = document.getElementById("cloudEmbeddedConfigId");
      var graphVersion = document.getElementById("cloudEmbeddedGraphVersion");
      var redirectUri = document.getElementById("cloudEmbeddedRedirectUri");
      if (appId && es.appId && !appId.value) appId.value = es.appId;
      if (configId && es.configurationId && !configId.value) configId.value = es.configurationId;
      if (graphVersion && st.graphVersion && !graphVersion.value) graphVersion.value = st.graphVersion;
      if (redirectUri && es.redirectUri && !redirectUri.value) redirectUri.value = es.redirectUri;
    }

    async function loadCloudStatus(){
      try{
        var r = await cloudFetch("/api/wa-cloud/status");
        var j = await r.json();
        if (!r.ok) throw new Error(normalizeCloudApiError(r.status, j, "Falha ao consultar status"));
        cloudStatusCache = j;
        renderCloudConnectionStatus();
        return j;
      }catch(e){
        var el = document.getElementById("cloudConnectionStatus");
        if (el) {
          el.classList.add("cloudStatusPanel");
          el.innerHTML = '<div class="cloudStatusCard cloudStatusWarning"><div class="cloudStatusLabel">Erro ao carregar conexão</div><div class="cloudStatusValue">' + escapeHtml(e && e.message ? e.message : String(e)) + '</div></div>';
        }
        throw e;
      }
    }

    async function saveCloudEmbeddedSettings(){
      var payload = {
        appId: document.getElementById("cloudEmbeddedAppId").value,
        configurationId: document.getElementById("cloudEmbeddedConfigId").value,
        appSecret: document.getElementById("cloudEmbeddedAppSecret").value,
        graphVersion: document.getElementById("cloudEmbeddedGraphVersion").value || "v25.0",
        redirectUri: document.getElementById("cloudEmbeddedRedirectUri").value || ""
      };

      if (!String(payload.appId || "").trim()) { toast("err", "Meta", "Informe o App ID"); return; }
      if (!String(payload.configurationId || "").trim()) { toast("err", "Meta", "Informe o Configuration ID"); return; }
      if (!String(payload.appSecret || "").trim()) { toast("err", "Meta", "Informe o App Secret"); return; }

      setCloudEmbeddedLog("Salvando configuração do App da Meta...");
      try{
        var r = await cloudFetch("/api/wa-cloud/embedded/settings", {
          method: "PUT",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify(payload)
        });
        var j = await r.json();
        if (!r.ok) throw new Error(normalizeCloudApiError(r.status, j, "Falha ao salvar configuração"));
        document.getElementById("cloudEmbeddedAppSecret").value = "";
        setCloudEmbeddedLog("Configuração salva. Agora clique em Vincular Facebook e WhatsApp.");
        toast("ok", "Meta", "Configuração salva");
        await loadCloudStatus();
      }catch(e){
        setCloudEmbeddedLog("Erro: " + (e && e.message ? e.message : String(e)));
        toast("err", "Meta", e && e.message ? e.message : String(e));
      }
    }

    function ensureFacebookSdk(appId, graphVersion){
      appId = String(appId || "").trim();
      graphVersion = String(graphVersion || "v25.0").trim() || "v25.0";
      var key = appId + "|" + graphVersion;
      if (window.FB && cloudFbSdkKey === key) return Promise.resolve(window.FB);
      if (cloudFbSdkPromise && cloudFbSdkKey === key) return cloudFbSdkPromise;

      cloudFbSdkKey = key;
      cloudFbSdkPromise = new Promise(function(resolve, reject){
        if (!document.getElementById("fb-root")){
          var root = document.createElement("div");
          root.id = "fb-root";
          document.body.appendChild(root);
        }

        window.fbAsyncInit = function(){
          try{
            window.FB.init({
              appId: appId,
              cookie: false,
              xfbml: true,
              version: graphVersion
            });
            resolve(window.FB);
          }catch(e){ reject(e); }
        };

        var existing = document.getElementById("facebook-jssdk");
        if (existing) {
          try{
            if (window.FB) {
              window.FB.init({ appId: appId, cookie: false, xfbml: true, version: graphVersion });
              resolve(window.FB);
            }
          }catch(e){ reject(e); }
          return;
        }

        var js = document.createElement("script");
        js.id = "facebook-jssdk";
        js.async = true;
        js.defer = true;
        js.crossOrigin = "anonymous";
        js.src = "https://connect.facebook.net/pt_BR/sdk.js";
        js.onerror = function(){ reject(new Error("Não foi possível carregar o SDK do Facebook. Verifique HTTPS, domínio permitido e bloqueadores do navegador.")); };
        document.head.appendChild(js);
      });
      return cloudFbSdkPromise;
    }

    function updateEmbeddedIdsFromSession(data){
      if (!data || !data.data) return;
      var d = data.data || {};
      cloudEmbeddedIds.wabaId = d.waba_id || d.wabaId || cloudEmbeddedIds.wabaId || "";
      cloudEmbeddedIds.phoneNumberId = d.phone_number_id || d.phoneNumberId || cloudEmbeddedIds.phoneNumberId || "";
      cloudEmbeddedIds.businessId = d.business_id || d.businessId || cloudEmbeddedIds.businessId || "";
    }

    async function cloudPostEmbeddedExchange(forceReplace){
      var r = await cloudFetch("/api/wa-cloud/embedded/exchange", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          code: cloudEmbeddedCode,
          wabaId: cloudEmbeddedIds.wabaId,
          phoneNumberId: cloudEmbeddedIds.phoneNumberId,
          businessId: cloudEmbeddedIds.businessId || "",
          sessionInfo: cloudEmbeddedSession || null,
          forceReplace: !!forceReplace
        })
      });
      var j = await r.json();
      if (!r.ok) {
        var err = new Error(normalizeCloudApiError(r.status, j, "Falha ao finalizar vínculo"));
        err.payload = j || null;
        err.status = r.status;
        err.code = j && j.code;
        throw err;
      }
      return j;
    }

    function cloudConnectionMismatchMessage(details){
      details = details || {};
      var current = details.current || {};
      var incoming = details.incoming || {};
      return [
        "A Meta retornou um número/WABA diferente do que já estava salvo no painel.",
        "",
        "Salvo agora: " + (current.displayPhoneNumber || current.phoneNumberId || "sem número") + " | WABA: " + (current.wabaId || "-"),
        "Retornado pela Meta: Phone Number ID " + (incoming.phoneNumberId || "-") + " | WABA: " + (incoming.wabaId || "-"),
        "",
        "Para evitar trocar o número sem querer, o sistema bloqueou a substituição automática."
      ].join("\n");
    }

    async function finalizeEmbeddedSignupIfReady(){
      if (!cloudEmbeddedCode || !cloudEmbeddedIds.wabaId || !cloudEmbeddedIds.phoneNumberId) {
        var missing = [];
        if (!cloudEmbeddedCode) missing.push("authorization code");
        if (!cloudEmbeddedIds.wabaId) missing.push("WABA ID");
        if (!cloudEmbeddedIds.phoneNumberId) missing.push("Phone Number ID");
        setCloudEmbeddedLog("Aguardando dados da Meta: " + missing.join(", "));
        return;
      }

      setCloudEmbeddedLog("Finalizando vínculo e salvando token oficial no servidor...");
      try{
        var j = await cloudPostEmbeddedExchange(false);
        setCloudEmbeddedLog(JSON.stringify(j, null, 2));
        toast("ok", "WhatsApp vinculado", "A API oficial já pode criar modelos e enviar campanhas.", 5200);
        await loadCloudStatus();
        await cloudListTemplates().catch(function(){});
      }catch(e){
        var payload = e && e.payload ? e.payload : null;
        var details = payload && (payload.details || payload);
        if (payload && (payload.code === "CLOUD_CONNECTION_MISMATCH" || (details && details.code === "CLOUD_CONNECTION_MISMATCH"))) {
          var msg = cloudConnectionMismatchMessage(details);
          setCloudEmbeddedLog(msg);
          var confirmed = await uiConfirm("A Meta retornou outro número", msg + "\n\nDeseja substituir a conexão salva por esse retorno da Meta?", { tone: "danger", okText: "Substituir conexão", icon: "ph-warning-circle" });
          if (!confirmed) {
            toast("err", "Vínculo bloqueado", "Nenhum número foi substituído.", 5200);
            return;
          }
          try{
            var forced = await cloudPostEmbeddedExchange(true);
            setCloudEmbeddedLog(JSON.stringify(forced, null, 2));
            toast("ok", "Conexão substituída", "O número retornado pela Meta foi salvo no painel.", 5200);
            await loadCloudStatus();
            await cloudListTemplates().catch(function(){});
            return;
          }catch(e2){
            setCloudEmbeddedLog("Erro ao substituir vínculo: " + (e2 && e2.message ? e2.message : String(e2)));
            toast("err", "Vínculo não finalizado", e2 && e2.message ? e2.message : String(e2), 6500);
            return;
          }
        }
        setCloudEmbeddedLog("Erro ao finalizar vínculo: " + (e && e.message ? e.message : String(e)));
        toast("err", "Vínculo não finalizado", e && e.message ? e.message : String(e), 6500);
      }
    }

    async function launchCloudEmbeddedSignup(){
      var st = cloudStatusCache || await loadCloudStatus();
      var es = st.embeddedSignup || {};
      if (!es.configured) {
        toast("err", "Meta", "Configure App ID, Configuration ID e App Secret primeiro.");
        var details = document.getElementById("cloudEmbeddedSettingsDetails");
        if (details) details.open = true;
        return;
      }

      if (location.protocol !== "https:" && location.hostname !== "localhost") {
        toast("err", "Meta", "O Embedded Signup exige HTTPS no domínio de produção.", 5500);
        return;
      }

      cloudEmbeddedCode = "";
      cloudEmbeddedSession = null;
      cloudEmbeddedIds = { wabaId: "", phoneNumberId: "", businessId: "" };
      setCloudEmbeddedLog("Abrindo login oficial da Meta...");

      try{
        var FB = await ensureFacebookSdk(es.appId, st.graphVersion || "v25.0");
        FB.login(function(response){
          if (response && response.authResponse && response.authResponse.code) {
            cloudEmbeddedCode = response.authResponse.code;
            setCloudEmbeddedLog("Código de autorização recebido. Aguardando/validando dados do WhatsApp...");
            finalizeEmbeddedSignupIfReady();
          } else {
            setCloudEmbeddedLog("Login cancelado ou autorização incompleta pela Meta.");
            toast("err", "Meta", "Login cancelado ou autorização incompleta.");
          }
        }, {
          config_id: es.configurationId,
          auth_type: "rerequest",
          response_type: "code",
          override_default_response_type: true,
          extras: {
            featureType: "whatsapp_business_app_onboarding",
            sessionInfoVersion: 3
          }
        });
      }catch(e){
        setCloudEmbeddedLog("Erro ao abrir Embedded Signup: " + (e && e.message ? e.message : String(e)));
        toast("err", "Meta", e && e.message ? e.message : String(e), 6500);
      }
    }

    window.addEventListener("message", function(event){
      if (!isFacebookOrigin(event.origin)) return;
      var data = null;
      try { data = typeof event.data === "string" ? JSON.parse(event.data) : event.data; }
      catch(_){ return; }
      if (!data || data.type !== "WA_EMBEDDED_SIGNUP") return;

      cloudEmbeddedSession = data;
      updateEmbeddedIdsFromSession(data);

      if (["FINISH", "FINISH_ONLY_WABA", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "FINISH_GRANT_ONLY_API_ACCESS"].indexOf(data.event) >= 0) {
        setCloudEmbeddedLog("Embedded Signup finalizado pela Meta. WABA: " + (cloudEmbeddedIds.wabaId || "-") + " | Phone Number ID: " + (cloudEmbeddedIds.phoneNumberId || "-"));
        finalizeEmbeddedSignupIfReady();
      } else if (data.event === "CANCEL") {
        setCloudEmbeddedLog("Fluxo cancelado na etapa: " + ((data.data && data.data.current_step) || "não informada"));
      } else if (data.event === "ERROR") {
        setCloudEmbeddedLog("Erro retornado pela Meta: " + ((data.data && (data.data.error_message || data.data.error)) || JSON.stringify(data.data || {})));
      } else {
        setCloudEmbeddedLog("Evento da Meta: " + data.event + "\n" + JSON.stringify(data.data || {}, null, 2));
      }
    });

    async function disconnectCloudEmbedded(){
      if (!(await uiConfirm("Desvincular API oficial?", "Isso remove o token, WABA ID e Phone Number ID salvos localmente neste painel.", { tone: "danger", okText: "Desvincular", icon: "ph-link-break" }))) return;
      try{
        var r = await cloudFetch("/api/wa-cloud/embedded", { method: "DELETE" });
        var j = await r.json();
        if (!r.ok) throw new Error(j && j.error ? j.error : "Falha ao desvincular");
        cloudTemplatesCache = [];
        renderCloudTemplatesList();
        toast("ok", "WhatsApp Oficial", "Integração desvinculada do painel");
        await loadCloudStatus();
      }catch(e){
        toast("err", "WhatsApp Oficial", e && e.message ? e.message : String(e));
      }
    }

    function cleanCloudTemplateName(name){
      return String(name || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_{2,}/g, "_");
    }

    function extractNumericVarsFromText(text){
      var nums = [];
      var re = /\{\{\s*(\d+)\s*\}\}/g;
      var m;
      while ((m = re.exec(String(text || "")))) {
        var n = Number(m[1]);
        if (Number.isFinite(n) && n > 0 && nums.indexOf(n) === -1) nums.push(n);
      }
      nums.sort(function(a,b){ return a-b; });
      return nums;
    }

    function csvSplitLine(line, sep){
      var out = [];
      var cur = "";
      var inQuotes = false;
      for (var i=0;i<String(line || "").length;i++){
        var ch = line[i];
        var next = line[i+1];
        if (ch === '"'){
          if (inQuotes && next === '"') { cur += '"'; i++; }
          else inQuotes = !inQuotes;
        } else if (ch === sep && !inQuotes){
          out.push(cur);
          cur = "";
        } else {
          cur += ch;
        }
      }
      out.push(cur);
      return out.map(function(x){ return String(x || "").trim(); });
    }

    function parseCsv(text){
      var rawLines = String(text || "").split(/\r?\n/).filter(function(l){ return String(l || "").trim(); });
      if (!rawLines.length) return [];
      var first = rawLines[0];
      var sep = (first.split(";").length >= first.split(",").length) ? ";" : ",";
      var header = csvSplitLine(first, sep).map(function(h){ return cleanHeaderKey(h); });
      var rows = [];
      for (var i=1;i<rawLines.length;i++){
        var cols = csvSplitLine(rawLines[i], sep);
        var obj = {};
        for (var c=0;c<header.length;c++) obj[header[c]] = (cols[c] || "").trim();
        rows.push(obj);
      }
      return rows;
    }

    function cleanHeaderKey(s){
      return String(s || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "_");
    }

    function renderBodyExampleInputs(){
      var body = document.getElementById("cloudTemplateBody");
      var wrap = document.getElementById("cloudBodyExamples");
      if (!body || !wrap) return;
      var vars = extractNumericVarsFromText(body.value || "");
      if (!vars.length){
        wrap.innerHTML = '<div class="hint">Sem variáveis no corpo. Se quiser personalizar, use {{1}}, {{2}}...</div>';
        return;
      }
      var okSeq = vars.every(function(n, idx){ return n === idx + 1; });
      var html = '<div class="label" style="margin-bottom:8px;">Exemplos obrigatórios para aprovação</div>';
      if (!okSeq){
        html += '<div class="hint" style="color:var(--g-red);margin-bottom:8px;">Use variáveis sequenciais: {{1}}, {{2}}, {{3}} sem pular números.</div>';
      }
      html += '<div style="display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap:10px;">';
      vars.forEach(function(n){
        html += '<label class="field"><div class="label">Exemplo {{'+n+'}}</div><input class="input cloudBodyExample" data-var="'+n+'" placeholder="Ex: '+(n===1?'Matheus':n===2?'20h':'Google Ads')+'" /></label>';
      });
      html += '</div>';
      wrap.innerHTML = html;
      wrap.querySelectorAll('.cloudBodyExample').forEach(function(input){ input.addEventListener('input', renderCloudCreateTemplatePreview); });
      renderCloudCreateTemplatePreview();
    }

    function renderHeaderExampleInput(){
      var header = document.getElementById("cloudTemplateHeader");
      var wrap = document.getElementById("cloudHeaderExampleWrap");
      if (!header || !wrap) return;
      var vars = extractNumericVarsFromText(header.value || "");
      wrap.style.display = vars.length ? "block" : "none";
      renderCloudCreateTemplatePreview();
    }

    function getCloudTemplateExampleValue(n){
      var input = document.querySelector('.cloudBodyExample[data-var="' + n + '"]');
      if (input && String(input.value || '').trim()) return String(input.value || '').trim();
      if (n === 1) return 'Matheus';
      if (n === 2) return 'Casa do Ads';
      if (n === 3) return 'Google Ads com IA';
      return 'Exemplo ' + n;
    }

    function applyCloudTemplateExamples(textValue){
      return String(textValue || '').replace(/\{\{\s*(\d+)\s*\}\}/g, function(_, n){
        return getCloudTemplateExampleValue(Number(n));
      });
    }

    function getCloudTemplateButtonsPayload(){
      var out = [];
      for (var i=1;i<=3;i++){
        var typeEl = document.getElementById('cloudButtonType' + i);
        var textEl = document.getElementById('cloudButtonText' + i);
        var valueEl = document.getElementById('cloudButtonValue' + i);
        var type = typeEl ? String(typeEl.value || '').trim() : '';
        var label = textEl ? String(textEl.value || '').trim() : '';
        var value = valueEl ? String(valueEl.value || '').trim() : '';
        if (!type) continue;
        if (!label) label = type === 'URL' ? 'Abrir link' : type === 'PHONE_NUMBER' ? 'Ligar' : 'Responder';
        var btn = { type: type, text: label };
        if (type === 'URL') btn.url = value;
        if (type === 'PHONE_NUMBER') btn.phone_number = value;
        out.push(btn);
      }
      return out;
    }

    function syncCloudButtonCompatibilityTextarea(){
      var textarea = document.getElementById('cloudTemplateButtons');
      if (!textarea) return;
      textarea.value = getCloudTemplateButtonsPayload()
        .filter(function(b){ return b.type === 'QUICK_REPLY'; })
        .map(function(b){ return b.text; })
        .join('\n');
    }

    function updateCloudButtonRows(){
      for (var i=1;i<=3;i++){
        var typeEl = document.getElementById('cloudButtonType' + i);
        var valueEl = document.getElementById('cloudButtonValue' + i);
        if (!typeEl || !valueEl) continue;
        var type = String(typeEl.value || '');
        if (type === 'URL'){
          valueEl.disabled = false;
          valueEl.placeholder = 'https://seudominio.com/pagina';
        } else if (type === 'PHONE_NUMBER'){
          valueEl.disabled = false;
          valueEl.placeholder = '+5511999999999';
        } else {
          valueEl.disabled = true;
          valueEl.value = '';
          valueEl.placeholder = 'Não necessário';
        }
      }
      syncCloudButtonCompatibilityTextarea();
    }

    function cloudTemplateStatusLabel(status){
      var s = String(status || '').toUpperCase();
      var map = {
        APPROVED: 'Aprovado',
        PENDING: 'Em análise',
        IN_REVIEW: 'Em análise',
        PENDING_REVIEW: 'Em análise',
        REJECTED: 'Recusado',
        PAUSED: 'Pausado',
        DISABLED: 'Desativado',
        IN_APPEAL: 'Em recurso',
        APPEAL_REQUESTED: 'Em recurso',
        PENDING_DELETION: 'Exclusão pendente',
        LIBRARY: 'Biblioteca Meta'
      };
      return map[s] || (s || 'Sem status');
    }

    function renderCloudTemplateStatusPanel(){
      var cards = document.getElementById('cloudTemplateStatusCards');
      var list = document.getElementById('cloudTemplateRecentStatusList');
      if (!cards || !list) return;
      var items = Array.isArray(cloudTemplatesCache) ? cloudTemplatesCache : [];
      var accountItems = items.filter(function(t){ return String(t && t.source || 'account') !== 'library'; });
      var libraryItems = items.filter(function(t){ return String(t && t.source || '') === 'library'; });
      var count = function(statuses){
        statuses = Array.isArray(statuses) ? statuses : [statuses];
        return accountItems.filter(function(t){ return statuses.indexOf(String(t.status || '').toUpperCase()) >= 0; }).length;
      };
      var pending = count(['PENDING','IN_REVIEW','PENDING_REVIEW']);
      var approved = count('APPROVED');
      var rejected = count('REJECTED');
      var paused = count(['PAUSED','DISABLED','PENDING_DELETION','IN_APPEAL','APPEAL_REQUESTED']);

      cards.innerHTML =
        '<div class="cloudTemplateStatusMini"><span>Total conta</span><b>' + accountItems.length + '</b></div>' +
        '<div class="cloudTemplateStatusMini warn"><span>Em análise</span><b>' + pending + '</b></div>' +
        '<div class="cloudTemplateStatusMini ok"><span>Aprovados</span><b>' + approved + '</b></div>' +
        '<div class="cloudTemplateStatusMini err"><span>Recusados</span><b>' + rejected + '</b></div>' +
        '<div class="cloudTemplateStatusMini pause"><span>Pausados/Recurso</span><b>' + paused + '</b></div>' +
        '<div class="cloudTemplateStatusMini"><span>Biblioteca Meta</span><b>' + libraryItems.length + '</b></div>';

      var lastSubmitted = null;
      try{ lastSubmitted = JSON.parse(localStorage.getItem('cloudLastTemplateSubmitted') || 'null'); }catch(_){}
      var recent = accountItems.slice().sort(function(a,b){
        return String(b.updated_time || b.created_time || b.name || '').localeCompare(String(a.updated_time || a.created_time || a.name || ''));
      }).slice(0,4);

      var html = '';
      if (lastSubmitted && lastSubmitted.name){
        var match = accountItems.find(function(t){
          return String(t.name || '') === String(lastSubmitted.name || '') && String(t.language || '') === String(lastSubmitted.language || '');
        });
        html += '<div class="cloudTemplateRecentItem"><b>Último enviado: ' + escapeHtml(lastSubmitted.name) + '</b><span>Status: ' + escapeHtml(match ? cloudTemplateStatusLabel(match.status) : 'aguardando atualização da Meta') + '</span></div>';
      }
      if (!recent.length){
        html += '<div class="cloudTemplateRecentItem"><b>Nenhum modelo da conta carregado ainda</b><span>Clique em Atualizar status para consultar a Meta.</span></div>';
      } else {
        recent.forEach(function(t){
          html += '<div class="cloudTemplateRecentItem"><b>' + escapeHtml(t.name || 'Modelo') + '</b><span>' + escapeHtml(cloudTemplateStatusLabel(t.status)) + ' • ' + escapeHtml(t.category || 'Categoria') + ' • ' + escapeHtml(t.language || 'Idioma') + '</span></div>';
        });
      }
      list.innerHTML = html;
    }

    function renderCloudCreateTemplatePreview(){
      var bodyEl = document.getElementById('cloudWaPreviewBody');
      var headerEl = document.getElementById('cloudWaPreviewHeader');
      var footerEl = document.getElementById('cloudWaPreviewFooter');
      var buttonsEl = document.getElementById('cloudWaPreviewButtons');
      var metaEl = document.getElementById('cloudWaTemplateMeta');
      var varsEl = document.getElementById('cloudWaPlaceholderExamples');
      if (!bodyEl || !headerEl || !footerEl || !buttonsEl || !metaEl || !varsEl) return;

      var name = (document.getElementById('cloudNewTemplateName') || {}).value || '';
      var category = (document.getElementById('cloudTemplateCategory') || {}).value || 'MARKETING';
      var language = (document.getElementById('cloudTemplateLanguage') || {}).value || 'pt_BR';
      var header = (document.getElementById('cloudTemplateHeader') || {}).value || '';
      var headerExample = (document.getElementById('cloudTemplateHeaderExample') || {}).value || '';
      var body = (document.getElementById('cloudTemplateBody') || {}).value || '';
      var footer = (document.getElementById('cloudTemplateFooter') || {}).value || '';
      updateCloudButtonRows();
      var buttons = getCloudTemplateButtonsPayload();
      var renderedHeader = applyCloudTemplateExamples(header);
      var renderedBody = applyCloudTemplateExamples(body);
      var headerHasVar = /\{\{\s*\d+\s*\}\}/.test(header || '');
      if (headerHasVar && String(headerExample || '').trim()){
        renderedHeader = String(header || '').replace(/\{\{\s*\d+\s*\}\}/g, String(headerExample || '').trim());
      }
      if (!String(renderedBody || '').trim()) renderedBody = 'Digite o corpo do modelo para ver a prévia da mensagem.';

      headerEl.textContent = renderedHeader || '';
      headerEl.style.display = renderedHeader ? '' : 'none';
      bodyEl.textContent = renderedBody;
      footerEl.textContent = footer || '';
      footerEl.style.display = footer ? '' : 'none';

      if (buttons.length){
        buttonsEl.innerHTML = buttons.map(function(btn){
          var extra = '';
          if (btn.type === 'URL') extra = '<small>' + escapeHtml(btn.url || 'https://...') + '</small>';
          if (btn.type === 'PHONE_NUMBER') extra = '<small>' + escapeHtml(btn.phone_number || '+55...') + '</small>';
          return '<div class="cloudWaButton">' + escapeHtml(btn.text || 'Botão') + extra + '</div>';
        }).join('');
        buttonsEl.style.display = '';
      } else {
        buttonsEl.innerHTML = '';
        buttonsEl.style.display = 'none';
      }

      metaEl.innerHTML = [
        '<span class="cloudWaMetaPill"><i class="ph ph-tag"></i>' + escapeHtml(category === 'UTILITY' ? 'Utility' : 'Marketing') + '</span>',
        '<span class="cloudWaMetaPill"><i class="ph ph-translate"></i>' + escapeHtml(language || 'pt_BR') + '</span>',
        '<span class="cloudWaMetaPill"><i class="ph ph-file-text"></i>' + escapeHtml(name || 'novo_modelo') + '</span>'
      ].join('');

      var nums = extractNumericVarsFromText((body || '') + ' ' + (header || ''));
      nums = Array.from(new Set(nums)).sort(function(a,b){ return a-b; });
      if (nums.length){
        varsEl.innerHTML = nums.map(function(n){
          return '<span><b>{{' + n + '}}</b> ' + escapeHtml(getCloudTemplateExampleValue(n)) + '</span>';
        }).join('');
      } else {
        varsEl.innerHTML = '<div class="cloudWaPlaceholder">Sem variáveis no modelo. Se quiser personalizar, use {{1}}, {{2}}...</div>';
      }
    }


    var cloudImportRows = [];
    var cloudImportColumns = [];
    var cloudImportFileName = "";
    var cloudImportMapping = { phone: "", displayName: "", personName: "", companyName: "", email: "", var1: "", var2: "", var3: "", var4: "", var5: "" };
    var cloudSavedSheetsCache = [];
    var cloudSavedSheetLoadedId = "";
    var cloudLeadPickerLastItems = [];
    var cloudLeadPickerRequestId = 0;

    function cloudColumnLetter(index){
      var n = Number(index || 0) + 1;
      var out = "";
      while (n > 0){
        var r = (n - 1) % 26;
        out = String.fromCharCode(65 + r) + out;
        n = Math.floor((n - 1) / 26);
      }
      return out || "A";
    }

    function cloudNormalizeForGuess(text){
      return String(text || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    }

    function cloudDetectDelimiter(line){
      var candidates = [";", ",", "\t", "|"];
      var best = ";", bestCount = 0;
      candidates.forEach(function(sep){
        var count = csvSplitLine(line, sep).length;
        if (count > bestCount){ bestCount = count; best = sep; }
      });
      return best;
    }

    function cloudMatrixFromDelimited(text){
      var rawLines = String(text || "").split(/\r?\n/).filter(function(l){ return String(l || "").trim(); });
      if (!rawLines.length) return [];
      var sep = cloudDetectDelimiter(rawLines[0]);
      return rawLines.map(function(line){ return csvSplitLine(line, sep); });
    }

    function cloudRowsFromMatrix(matrix){
      matrix = Array.isArray(matrix) ? matrix : [];
      if (!matrix.length) return { columns: [], rows: [] };
      var first = Array.isArray(matrix[0]) ? matrix[0] : [];
      var maxCols = first.length;
      for (var r=1;r<Math.min(matrix.length, 15);r++) maxCols = Math.max(maxCols, (matrix[r] || []).length);
      var columns = [];
      for (var c=0;c<maxCols;c++){
        var raw = String(first[c] || "").trim();
        var label = raw || ("Coluna " + cloudColumnLetter(c));
        columns.push({ key: "col_" + c, index: c, label: label, raw: raw, display: cloudColumnLetter(c) + " · " + label });
      }
      var rows = [];
      for (var i=1;i<matrix.length;i++){
        var line = matrix[i] || [];
        var hasValue = line.some(function(v){ return String(v || "").trim(); });
        if (!hasValue) continue;
        var obj = {};
        columns.forEach(function(col){ obj[col.key] = String(line[col.index] == null ? "" : line[col.index]).trim(); });
        rows.push(obj);
      }
      return { columns: columns, rows: rows };
    }

    function ensureSheetJs(){
      if (window.XLSX) return Promise.resolve(window.XLSX);
      return new Promise(function(resolve, reject){
        var existing = document.querySelector('script[data-sheetjs-loader="1"]');
        if (existing){
          existing.addEventListener('load', function(){ resolve(window.XLSX); });
          existing.addEventListener('error', function(){ reject(new Error('Não foi possível carregar o leitor de Excel. Exporte a planilha como CSV e tente novamente.')); });
          return;
        }
        var script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        script.async = true;
        script.defer = true;
        script.setAttribute('data-sheetjs-loader', '1');
        script.onload = function(){ window.XLSX ? resolve(window.XLSX) : reject(new Error('Leitor de Excel indisponível. Exporte a planilha como CSV.')); };
        script.onerror = function(){ reject(new Error('Não foi possível carregar o leitor de Excel. Exporte a planilha como CSV e tente novamente.')); };
        document.head.appendChild(script);
      });
    }

    async function cloudReadSpreadsheetFile(file){
      var name = String(file && file.name || "").toLowerCase();
      if (/\.(xlsx|xls)$/.test(name)){
        var XLSX = await ensureSheetJs();
        var buffer = await file.arrayBuffer();
        var wb = XLSX.read(buffer, { type: 'array' });
        var sheetName = wb.SheetNames && wb.SheetNames[0];
        if (!sheetName) throw new Error('A planilha não possui abas legíveis.');
        var ws = wb.Sheets[sheetName];
        return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      }
      var text = await file.text();
      return cloudMatrixFromDelimited(text);
    }

    function cloudGuessColumn(groups){
      var cols = cloudImportColumns || [];
      var normalized = cols.map(function(col){ return { key: col.key, n: cloudNormalizeForGuess(col.raw || col.label) }; });
      for (var g=0;g<groups.length;g++){
        for (var i=0;i<normalized.length;i++){
          if (groups[g].indexOf(normalized[i].n) >= 0) return normalized[i].key;
        }
      }
      for (var g2=0;g2<groups.length;g2++){
        for (var i2=0;i2<normalized.length;i2++){
          if (normalized[i2].n.indexOf(groups[g2]) >= 0 || groups[g2].indexOf(normalized[i2].n) >= 0) return normalized[i2].key;
        }
      }
      return "";
    }

    function cloudBuildImportDefaults(){
      var phone = cloudGuessColumn(['telefone','whatsapp','celular','phone','fone','numero','numero_whatsapp','telefone_celular','mobile']);
      var displayName = cloudGuessColumn(['nome','name','cliente','lead','nome_cliente','contato','nome_completo','full_name']);
      var personName = cloudGuessColumn(['nome_pessoa','pessoa','responsavel','nome_do_contato','contato','contact_name']);
      var companyName = cloudGuessColumn(['empresa','nome_empresa','company','negocio','razao_social','loja','marca']);
      var email = cloudGuessColumn(['email','e_mail','mail','correio']);
      cloudImportMapping = {
        phone: phone,
        displayName: displayName || personName || companyName,
        personName: personName,
        companyName: companyName,
        email: email,
        var1: displayName || personName || companyName,
        var2: companyName || personName || email,
        var3: "",
        var4: "",
        var5: ""
      };
    }

    function cloudColumnOptions(selected, allowBlank){
      var html = allowBlank ? '<option value="">Não usar</option>' : '<option value="">Selecione</option>';
      (cloudImportColumns || []).forEach(function(col){
        html += '<option value="' + escapeHtml(col.key) + '" ' + (selected === col.key ? 'selected' : '') + '>' + escapeHtml(col.display) + '</option>';
      });
      return html;
    }

    function cloudMappingField(key, label, required, hint){
      return '<div class="cloudMapperField">' +
        '<div class="labelRow"><label for="cloudMap_' + escapeHtml(key) + '">' + escapeHtml(label) + '</label>' + (required ? '<span class="cloudRequiredPill">Obrigatório</span>' : '') + '</div>' +
        '<select id="cloudMap_' + escapeHtml(key) + '" class="input cloudMapSelect" data-map-key="' + escapeHtml(key) + '">' + cloudColumnOptions(cloudImportMapping[key], !required) + '</select>' +
        (hint ? '<small>' + escapeHtml(hint) + '</small>' : '') +
      '</div>';
    }
    function cloudColumnSelectedValue(columnKey){
      var map = cloudImportMapping || {};
      var roles = ['phone','displayName','personName','companyName','email','var1','var2','var3','var4','var5'];
      for (var i=0;i<roles.length;i++){
        if (map[roles[i]] === columnKey) return roles[i];
      }
      return '';
    }

    function cloudUnifiedColumnOptions(selected){
      var groups = [
        { label: '', items: [['', 'Ignorar coluna']] },
        { label: 'Dados do contato', items: [
          ['phone', 'Telefone / WhatsApp'],
          ['displayName', 'Nome principal'],
          ['personName', 'Nome da pessoa'],
          ['companyName', 'Nome da empresa'],
          ['email', 'E-mail']
        ]},
        { label: 'Variáveis', items: [
          ['var1', 'Enviar como {{1}}'],
          ['var2', 'Enviar como {{2}}'],
          ['var3', 'Enviar como {{3}}'],
          ['var4', 'Enviar como {{4}}'],
          ['var5', 'Enviar como {{5}}']
        ]}
      ];
      var html = '';
      groups.forEach(function(group){
        if (group.label) html += '<optgroup label="' + escapeHtml(group.label) + '">';
        group.items.forEach(function(item){
          html += '<option value="' + escapeHtml(item[0]) + '" ' + (selected === item[0] ? 'selected' : '') + '>' + escapeHtml(item[1]) + '</option>';
        });
        if (group.label) html += '</optgroup>';
      });
      return html;
    }

    function cloudImportNameKey(){
      return cloudImportMapping.displayName || cloudImportMapping.personName || cloudImportMapping.companyName || '';
    }

    function cloudImportValue(row, key){
      return key ? String((row || {})[key] == null ? '' : (row || {})[key]).trim() : '';
    }

    function cloudClearDuplicateSelection(changed, selector){
      if (!changed || !changed.value) return;
      document.querySelectorAll(selector).forEach(function(sel){
        if (sel !== changed && sel.value === changed.value) sel.value = '';
      });
    }
    function cloudReadMappingFromUI(){
      var next = { phone: '', displayName: '', personName: '', companyName: '', email: '', var1: '', var2: '', var3: '', var4: '', var5: '' };
      document.querySelectorAll('.cloudColumnMapSelect').forEach(function(sel){
        var columnKey = sel.getAttribute('data-column-key') || '';
        var role = sel.value || '';
        if (columnKey && role && Object.prototype.hasOwnProperty.call(next, role)) next[role] = columnKey;
      });
      cloudImportMapping = next;
    }

    function cloudRenderImportValidation(){
      var el = document.getElementById('cloudImportValidation');
      if (!el) return;
      var hasPhone = !!cloudImportMapping.phone;
      var hasName = !!cloudImportNameKey();
      var vars = [];
      for (var i=1;i<=5;i++) if (cloudImportMapping['var' + i]) vars.push('{{' + i + '}}');
      el.innerHTML = '' +
        '<span class="pill ' + (hasPhone ? 'ok' : 'err') + '"><i class="ph ' + (hasPhone ? 'ph-check-circle' : 'ph-x-circle') + '"></i> Telefone ' + (hasPhone ? 'selecionado' : 'obrigatório') + '</span>' +
        '<span class="pill ' + (hasName ? 'ok' : 'err') + '"><i class="ph ' + (hasName ? 'ph-check-circle' : 'ph-x-circle') + '"></i> Nome ' + (hasName ? 'selecionado' : 'obrigatório') + '</span>' +
        '<span class="pill ' + (vars.length ? 'ok' : 'warn') + '"><i class="ph ' + (vars.length ? 'ph-check-circle' : 'ph-info') + '"></i> Variáveis: ' + (vars.length ? vars.join(', ') : 'automático com nome') + '</span>';
    }
    function renderCloudImportSample(){
      var wrap = document.getElementById('cloudImportSample');
      cloudReadMappingFromUI();
      cloudRenderImportValidation();
      if (wrap) wrap.innerHTML = '';
    }
    function renderCloudImportMapper(){
      var mapper = document.getElementById('cloudImportMapper');
      var req = document.getElementById('cloudImportRequiredFields');
      var opt = document.getElementById('cloudImportOptionalFields');
      var vars = document.getElementById('cloudImportVariableFields');
      var nameEl = document.getElementById('cloudImportFileName');
      var statsEl = document.getElementById('cloudImportStats');
      if (!mapper || !req) return;
      mapper.hidden = !cloudImportRows.length;
      if (!cloudImportRows.length) return;
      if (opt) opt.innerHTML = '';
      if (vars) vars.innerHTML = '';
      if (nameEl) nameEl.textContent = cloudImportFileName || 'Planilha carregada';
      if (statsEl) statsEl.textContent = cloudImportRows.length + ' linha(s) encontradas · ' + cloudImportColumns.length + ' coluna(s). Use a prévia abaixo e escolha o papel de cada coluna.';

      var rows = (cloudImportRows || []).slice(0, 4);
      var html = '<div class="cloudSheetMapHint"><i class="ph ph-cursor-click"></i><span>Prévia da planilha: embaixo do nome de cada coluna, escolha se ela é telefone, nome, empresa, e-mail ou uma variável do modelo.</span></div>';
      html += '<div class="cloudSheetMapWrap"><table class="cloudSheetMapTable"><thead><tr><th class="cloudSheetRowIndex">#</th>';
      (cloudImportColumns || []).forEach(function(col){
        var selected = cloudColumnSelectedValue(col.key);
        var cls = selected ? ' isMapped' : '';
        if (selected === 'phone') cls += ' isPhone';
        if (selected === 'displayName' || selected === 'personName' || selected === 'companyName') cls += ' isName';
        if (/^var\d+$/.test(selected)) cls += ' isVariable';
        html += '<th class="' + cls.trim() + '">' +
          '<div class="cloudSheetColumnMeta"><span class="cloudSheetLetter">' + escapeHtml(cloudColumnLetter(col.index)) + '</span><div><b title="' + escapeHtml(col.label) + '">' + escapeHtml(col.label) + '</b></div></div>' +
          '<select class="input cloudSheetMapSelect cloudColumnMapSelect" data-column-key="' + escapeHtml(col.key) + '">' + cloudUnifiedColumnOptions(selected) + '</select>' +
        '</th>';
      });
      html += '</tr></thead><tbody>';
      rows.forEach(function(row, index){
        html += '<tr><td class="cloudSheetRowIndex">' + (index + 1) + '</td>';
        (cloudImportColumns || []).forEach(function(col){
          var value = cloudImportValue(row, col.key);
          html += '<td><span class="cloudSheetSample" title="' + escapeHtml(value) + '">' + (value ? escapeHtml(value) : '&nbsp;') + '</span></td>';
        });
        html += '</tr>';
      });
      if (!rows.length){
        html += '<tr><td class="cloudSheetRowIndex">1</td><td colspan="' + Math.max(1, (cloudImportColumns || []).length) + '"><span class="cloudSheetSample">Nenhuma linha de exemplo encontrada.</span></td></tr>';
      }
      html += '</tbody></table></div>';
      req.innerHTML = html;
      req.querySelectorAll('.cloudColumnMapSelect').forEach(function(sel){
        sel.addEventListener('change', function(){
          cloudClearDuplicateSelection(sel, '.cloudColumnMapSelect');
          cloudReadMappingFromUI();
          renderCloudImportMapper();
        });
      });
      renderCloudImportSample();
    }


    async function cloudHandleImportFile(file){
      if (!file) return;
      var mapper = document.getElementById('cloudImportMapper');
      try{
        if (mapper) mapper.hidden = false;
        var log = document.getElementById('cloudLog');
        if (log) log.innerHTML = '<div class="cloudResultCard"><b>Lendo planilha...</b><p class="cloudHelp">Aguarde enquanto o painel identifica as colunas.</p></div>';
        var matrix = await cloudReadSpreadsheetFile(file);
        var parsed = cloudRowsFromMatrix(matrix);
        if (!parsed.rows.length || !parsed.columns.length) throw new Error('Não encontrei linhas úteis na planilha. Confira se a primeira linha possui os títulos das colunas.');
        cloudImportRows = parsed.rows;
        cloudImportColumns = parsed.columns;
        cloudImportFileName = file.name || 'Planilha carregada';
        cloudSavedSheetLoadedId = '';
        cloudBuildImportDefaults();
        renderCloudImportMapper();
        if (log) log.innerHTML = '';
        toast('ok', 'Planilha carregada', 'Agora escolha quais colunas serão usadas no disparo.');
      }catch(e){
        cloudImportRows = [];
        cloudImportColumns = [];
        cloudImportFileName = '';
        if (mapper) mapper.hidden = true;
        toast('err', 'Importação', e && e.message ? e.message : String(e), 6500);
        var logErr = document.getElementById('cloudLog');
        if (logErr) logErr.innerHTML = '<div class="cloudResultCard err"><b>Não foi possível ler a planilha</b><p class="cloudHelp">' + escapeHtml(e && e.message ? e.message : String(e)) + '</p></div>';
      }
    }

        function cloudApplyImportMapping(){
      cloudReadMappingFromUI();
      if (!cloudImportRows.length){ toast('err', 'Importação', 'Importe uma planilha antes de aplicar o mapeamento.'); return; }
      if (!cloudImportMapping.phone){ toast('err', 'Mapeamento', 'Selecione qual coluna é o telefone.'); return; }
      var nameKey = cloudImportNameKey();
      if (!nameKey){ toast('err', 'Mapeamento', 'Selecione pelo menos uma coluna de nome. Pode ser nome principal, nome da pessoa ou nome da empresa.'); return; }
      var contacts = [];
      var seen = new Set();
      var invalid = 0;
      var duplicated = 0;
      var withoutName = 0;
      cloudImportRows.forEach(function(row){
        var phone = cloudImportValue(row, cloudImportMapping.phone).replace(/\D+/g, '');
        if (!phone || phone.length < 8){ invalid++; return; }
        if (seen.has(phone)){ duplicated++; return; }
        seen.add(phone);
        var personName = cloudImportValue(row, cloudImportMapping.personName);
        var companyName = cloudImportValue(row, cloudImportMapping.companyName);
        var email = cloudImportValue(row, cloudImportMapping.email);
        var nome = cloudImportValue(row, cloudImportMapping.displayName) || personName || companyName;
        if (!nome){ withoutName++; return; }
        var varMap = {};
        var vars = [];
        for (var i=1;i<=5;i++){
          var mapKey = cloudImportMapping['var' + i];
          var value = mapKey ? cloudImportValue(row, mapKey) : '';
          if (!value && i === 1) value = nome;
          if (!value && i === 2) value = companyName || personName || email;
          if (value){ varMap[i] = value; vars.push(value); }
        }
        contacts.push({ to: phone, nome: nome, personName: personName, companyName: companyName, email: email, varMap: varMap, vars: vars, source: 'spreadsheet' });
      });
      cloudContacts = contacts;
      var mapper = document.getElementById('cloudImportMapper');
      if (mapper) mapper.hidden = true;
      renderCloudPreview();
      var msg = cloudContacts.length + ' contato(s) prontos';
      var skipped = invalid + duplicated + withoutName;
      if (skipped) msg += ' · ' + skipped + ' linha(s) ignoradas';
      toast('ok', 'Contatos importados', msg, 5200);
    }


    function cloudCancelImportMapping(){
      cloudImportRows = [];
      cloudImportColumns = [];
      cloudImportFileName = '';
      cloudImportMapping = { phone: '', displayName: '', personName: '', companyName: '', email: '', var1: '', var2: '', var3: '', var4: '', var5: '' };
      cloudSavedSheetLoadedId = '';
      var mapper = document.getElementById('cloudImportMapper');
      if (mapper) mapper.hidden = true;
      var input = document.getElementById('cloudCsv');
      if (input) input.value = '';
    }

    function cloudSavedSheetsLocalKey(){
      return 'zape_cloud_saved_sheets_v1';
    }

    function cloudReadLocalSavedSheets(){
      try{
        var arr = JSON.parse(localStorage.getItem(cloudSavedSheetsLocalKey()) || '[]');
        return Array.isArray(arr) ? arr : [];
      }catch(e){ return []; }
    }

    function cloudWriteLocalSavedSheets(items){
      try{ localStorage.setItem(cloudSavedSheetsLocalKey(), JSON.stringify(Array.isArray(items) ? items : [])); return true; }
      catch(e){ return false; }
    }

    function cloudSavedSheetMeta(sheet){
      sheet = sheet || {};
      var rows = Array.isArray(sheet.rows) ? sheet.rows.length : Number(sheet.rowCount || 0);
      var cols = Array.isArray(sheet.columns) ? sheet.columns.length : Number(sheet.columnCount || 0);
      return rows + ' lead(s) · ' + cols + ' coluna(s)' + (sheet.updatedAt ? ' · atualizado em ' + formatDate(sheet.updatedAt) : '');
    }

    async function cloudLoadSavedSheets(){
      try{
        var r = await cloudFetch('/api/wa-cloud/sheets');
        var j = await r.json();
        if (!r.ok || !j || !j.ok) throw new Error(j && j.error ? j.error : 'Falha ao carregar planilhas');
        cloudSavedSheetsCache = Array.isArray(j.items) ? j.items : [];
      }catch(e){
        cloudSavedSheetsCache = cloudReadLocalSavedSheets();
      }
      renderCloudSavedSheets();
    }

    function renderCloudSavedSheets(){
      var box = document.getElementById('cloudSavedSheetsList');
      if (!box) return;
      var items = Array.isArray(cloudSavedSheetsCache) ? cloudSavedSheetsCache : [];
      if (!items.length){
        box.innerHTML = '<div class="cloudMiniEmpty">Nenhuma planilha salva ainda. Importe uma lista, revise as colunas e clique em Salvar planilha.</div>';
        return;
      }
      var html = '';
      items.forEach(function(sheet){
        var id = escapeHtml(sheet.id || '');
        html += '<div class="cloudSavedSheetRow" data-cloud-sheet-id="' + id + '">' +
          '<div class="cloudSavedSheetInfo"><b title="' + escapeHtml(sheet.name || sheet.fileName || 'Planilha') + '">' + escapeHtml(sheet.name || sheet.fileName || 'Planilha') + '</b><span>' + escapeHtml(cloudSavedSheetMeta(sheet)) + '</span></div>' +
          '<div class="cloudSavedSheetActions">' +
            '<button class="cloudIconBtn" type="button" data-cloud-sheet-action="load" title="Usar esta planilha"><i class="ph ph-upload-simple"></i></button>' +
            '<button class="cloudIconBtn danger" type="button" data-cloud-sheet-action="delete" title="Excluir planilha"><i class="ph ph-trash"></i></button>' +
          '</div>' +
        '</div>';
      });
      box.innerHTML = html;
      box.querySelectorAll('[data-cloud-sheet-action]').forEach(function(btn){
        btn.addEventListener('click', function(){
          var row = btn.closest('[data-cloud-sheet-id]');
          var id = row ? row.getAttribute('data-cloud-sheet-id') : '';
          var action = btn.getAttribute('data-cloud-sheet-action');
          if (action === 'load') cloudLoadSavedSheetIntoMapper(id);
          if (action === 'delete') cloudDeleteSavedSheet(id);
        });
      });
    }

    function cloudCurrentSheetPayload(name){
      cloudReadMappingFromUI();
      return {
        id: cloudSavedSheetLoadedId || '',
        name: String(name || cloudImportFileName || 'Planilha sem nome').trim(),
        fileName: cloudImportFileName || '',
        columns: cloudImportColumns || [],
        rows: cloudImportRows || [],
        mapping: cloudImportMapping || {},
        rowCount: (cloudImportRows || []).length,
        columnCount: (cloudImportColumns || []).length
      };
    }

    async function cloudSaveCurrentSheet(){
      if (!cloudImportRows.length || !cloudImportColumns.length){ toast('err', 'Planilha', 'Importe ou carregue uma planilha antes de salvar.'); return; }
      cloudReadMappingFromUI();
      var suggested = cloudImportFileName || 'Lista de contatos';
      var typed = window.prompt('Nome para identificar essa planilha salva:', suggested);
      if (typed == null) return;
      typed = String(typed || '').trim();
      if (!typed){ toast('warn', 'Planilha', 'Informe um nome para salvar.'); return; }
      var payload = cloudCurrentSheetPayload(typed);
      try{
        var r = await cloudFetch('/api/wa-cloud/sheets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        var j = await r.json();
        if (!r.ok || !j || !j.ok) throw new Error(j && j.error ? j.error : 'Falha ao salvar no servidor');
        cloudSavedSheetLoadedId = j.item && j.item.id ? j.item.id : cloudSavedSheetLoadedId;
        toast('ok', 'Planilha salva', 'Ela ficará disponível na biblioteca de planilhas.');
        await cloudLoadSavedSheets();
      }catch(e){
        var list = cloudReadLocalSavedSheets();
        var now = new Date().toISOString();
        payload.id = payload.id || ('local_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8));
        payload.createdAt = payload.createdAt || now;
        payload.updatedAt = now;
        var idx = list.findIndex(function(x){ return String(x.id) === String(payload.id); });
        if (idx >= 0) list[idx] = payload; else list.unshift(payload);
        if (!cloudWriteLocalSavedSheets(list)){
          toast('err', 'Planilha', 'Não consegui salvar. A planilha pode ser grande demais para o navegador.');
          return;
        }
        cloudSavedSheetLoadedId = payload.id;
        cloudSavedSheetsCache = list;
        renderCloudSavedSheets();
        toast('ok', 'Planilha salva neste navegador', 'O servidor não respondeu, então salvei localmente no navegador.');
      }
    }

    async function cloudFetchSavedSheetFull(id){
      var local = cloudReadLocalSavedSheets().find(function(x){ return String(x.id) === String(id); });
      try{
        var r = await cloudFetch('/api/wa-cloud/sheets/' + encodeURIComponent(id));
        var j = await r.json();
        if (!r.ok || !j || !j.ok) throw new Error(j && j.error ? j.error : 'Falha ao abrir planilha');
        return j.item || local;
      }catch(e){
        return local || (cloudSavedSheetsCache || []).find(function(x){ return String(x.id) === String(id); }) || null;
      }
    }

    async function cloudLoadSavedSheetIntoMapper(id){
      if (!id) return;
      var sheet = await cloudFetchSavedSheetFull(id);
      if (!sheet || !Array.isArray(sheet.rows) || !Array.isArray(sheet.columns)){
        toast('err', 'Planilha', 'Não consegui abrir essa planilha salva.');
        return;
      }
      cloudImportRows = sheet.rows || [];
      cloudImportColumns = sheet.columns || [];
      cloudImportFileName = sheet.name || sheet.fileName || 'Planilha salva';
      cloudImportMapping = Object.assign({ phone: '', displayName: '', personName: '', companyName: '', email: '', var1: '', var2: '', var3: '', var4: '', var5: '' }, sheet.mapping || {});
      cloudSavedSheetLoadedId = sheet.id || id;
      var mapper = document.getElementById('cloudImportMapper');
      if (mapper) mapper.hidden = false;
      renderCloudImportMapper();
      toast('ok', 'Planilha carregada', 'Revise as colunas e aplique o mapeamento para usar no disparo.');
    }

    async function cloudDeleteSavedSheet(id){
      if (!id) return;
      var sheet = (cloudSavedSheetsCache || []).find(function(x){ return String(x.id) === String(id); }) || {};
      var ok = await uiConfirm('Excluir planilha salva?', 'A planilha "' + (sheet.name || sheet.fileName || 'sem nome') + '" será removida da biblioteca.', { tone: 'danger', okText: 'Excluir', icon: 'ph-trash' });
      if (!ok) return;
      try{
        var r = await cloudFetch('/api/wa-cloud/sheets/' + encodeURIComponent(id), { method: 'DELETE' });
        var j = {}; try{ j = await r.json(); }catch{}
        if (!r.ok || !j.ok) throw new Error(j && j.error ? j.error : 'Falha ao excluir no servidor');
      }catch(e){
        var list = cloudReadLocalSavedSheets().filter(function(x){ return String(x.id) !== String(id); });
        cloudWriteLocalSavedSheets(list);
      }
      if (String(cloudSavedSheetLoadedId) === String(id)) cloudSavedSheetLoadedId = '';
      await cloudLoadSavedSheets();
      toast('ok', 'Planilha excluída', 'Removida da biblioteca.');
    }

    function cloudOpenLeadPicker(){
      var panel = document.getElementById('cloudLeadPicker');
      if (!panel) return;
      panel.hidden = false;
      cloudRenderLeadPickerTags();
      var qEl = document.getElementById('cloudLeadFilterSearch');
      if (qEl && !qEl.value) qEl.value = (document.getElementById('q') && document.getElementById('q').value || '').trim();
      var dddEl = document.getElementById('cloudLeadFilterDdd');
      if (dddEl && !dddEl.value) dddEl.value = filters && filters.ddd ? filters.ddd : '';
      var fromEl = document.getElementById('cloudLeadFilterFrom');
      if (fromEl && !fromEl.value) fromEl.value = filters && filters.from ? filters.from : '';
      var toEl = document.getElementById('cloudLeadFilterTo');
      if (toEl && !toEl.value) toEl.value = filters && filters.to ? filters.to : '';
      var stEl = document.getElementById('cloudLeadFilterStatus');
      if (stEl && !stEl.value) stEl.value = filters && filters.status ? filters.status : '';
      if (filters && filters.tagIds && filters.tagIds.length){
        document.querySelectorAll('#cloudLeadFilterTags input[type="checkbox"]').forEach(function(ch){ ch.checked = filters.tagIds.indexOf(ch.value) !== -1; });
      }
      cloudRenderLeadPickerPreview();
      setTimeout(function(){ panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 20);
    }

    function cloudCloseLeadPicker(){
      var panel = document.getElementById('cloudLeadPicker');
      if (panel) panel.hidden = true;
    }

    function cloudRenderLeadPickerTags(){
      var box = document.getElementById('cloudLeadFilterTags');
      if (!box) return;
      var tags = Array.isArray(cachedTags) ? cachedTags : [];
      if (!tags.length){ box.innerHTML = '<span class="hint">Nenhuma tag cadastrada.</span>'; return; }
      var html = '';
      tags.forEach(function(t){
        html += '<label><input type="checkbox" value="' + escapeHtml(t.id || '') + '"><span class="tagDot" style="background:' + safeCssColor(t.color, '#111827') + '"></span><span>' + escapeHtml(t.name || '') + '</span></label>';
      });
      box.innerHTML = html;
    }

    function cloudReadLeadPickerFilters(){
      var ids = [];
      document.querySelectorAll('#cloudLeadFilterTags input[type="checkbox"]').forEach(function(ch){ if (ch.checked) ids.push(ch.value); });
      return {
        q: String(document.getElementById('cloudLeadFilterSearch') && document.getElementById('cloudLeadFilterSearch').value || '').trim().toLowerCase(),
        ddd: String(document.getElementById('cloudLeadFilterDdd') && document.getElementById('cloudLeadFilterDdd').value || '').replace(/\D+/g, ''),
        origin: String(document.getElementById('cloudLeadFilterOrigin') && document.getElementById('cloudLeadFilterOrigin').value || '').trim().toLowerCase(),
        from: String(document.getElementById('cloudLeadFilterFrom') && document.getElementById('cloudLeadFilterFrom').value || ''),
        to: String(document.getElementById('cloudLeadFilterTo') && document.getElementById('cloudLeadFilterTo').value || ''),
        status: String(document.getElementById('cloudLeadFilterStatus') && document.getElementById('cloudLeadFilterStatus').value || ''),
        tagIds: ids
      };
    }

    function cloudLeadMatchesPicker(lead, cfg){
      lead = lead || {}; cfg = cfg || {};
      if (cfg.q){
        var hay = [lead.nome, lead.name, lead.email, lead.empresa, lead.company, lead.whatsapp_raw, lead.whatsapp_digits, lead.origem, lead.detalhe_origem].map(function(x){ return String(x || ''); }).join(' ').toLowerCase();
        var phoneMatch = typeof phoneMatchesSearchClient === 'function' ? phoneMatchesSearchClient(lead, cfg.q) : hay.indexOf(cfg.q) !== -1;
        if (hay.indexOf(cfg.q) === -1 && !phoneMatch) return false;
      }
      if (cfg.ddd){
        var ddd = typeof getDDDFromLead === 'function' ? getDDDFromLead(lead) : '';
        var raw = String(lead.whatsapp_digits || lead.whatsapp_raw || '').replace(/\D+/g, '');
        if (ddd !== cfg.ddd && raw.indexOf(cfg.ddd) !== 0 && raw.indexOf('55' + cfg.ddd) !== 0 && raw.indexOf('351' + cfg.ddd) !== 0) return false;
      }
      if (cfg.origin){
        var origin = [lead.origem, lead.origin, lead.source, lead.detalhe_origem, lead.webhook, lead.webhookName].map(function(x){ return String(x || ''); }).join(' ').toLowerCase();
        if (origin.indexOf(cfg.origin) === -1) return false;
      }
      if (cfg.from || cfg.to){
        var t = new Date(lead.createdAt || lead.data || lead.date || '').getTime();
        if (isNaN(t)) return false;
        if (cfg.from && t < new Date(cfg.from + 'T00:00:00').getTime()) return false;
        if (cfg.to && t > new Date(cfg.to + 'T23:59:59').getTime()) return false;
      }
      if (cfg.status){
        var st = typeof inferStatus === 'function' ? inferStatus(lead) : String(lead.status || '');
        if (st !== cfg.status) return false;
      }
      if (cfg.tagIds && cfg.tagIds.length){
        var leadTagIds = Array.isArray(lead.tagIds) ? lead.tagIds.map(String) : [];
        var has = cfg.tagIds.some(function(id){ return leadTagIds.indexOf(String(id)) !== -1; });
        if (!has) return false;
      }
      return true;
    }

    function cloudLeadPickerQueryParams(){
      var cfg = cloudReadLeadPickerFilters();
      var p = new URLSearchParams();
      if (cfg.q) p.set('q', cfg.q);
      if (cfg.ddd) p.set('ddd', cfg.ddd);
      if (cfg.origin) p.set('origin', cfg.origin);
      if (cfg.from) p.set('from', cfg.from);
      if (cfg.to) p.set('to', cfg.to);
      if (cfg.status) p.set('status', cfg.status);
      if (cfg.tagIds && cfg.tagIds.length) p.set('tags', cfg.tagIds.join(','));
      p.set('dedupe', '1');
      p.set('notDeliveredAfterMin', String(STATUS_FILTER_TIMEOUT_MIN));
      p.set('sortBy', 'createdAt');
      p.set('sortDir', 'desc');
      return p;
    }

    async function cloudGetLeadPickerItems(){
      return await fetchAllLeadPages(cloudLeadPickerQueryParams());
    }

    async function cloudRenderLeadPickerPreview(){
      var requestId = ++cloudLeadPickerRequestId;
      var count = document.getElementById('cloudLeadPickerCount');
      var wrap = document.getElementById('cloudLeadPickerPreview');
      if (count) count.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Consultando leads...';
      if (wrap) wrap.innerHTML = '<div class="cloudMiniEmpty">Aplicando os mesmos filtros da API e da exportação...</div>';
      try {
        var items = await cloudGetLeadPickerItems();
        if (requestId !== cloudLeadPickerRequestId) return;
        cloudLeadPickerLastItems = items;
        if (count) count.innerHTML = '<i class="ph ph-users"></i> ' + items.length + ' lead(s) encontrados';
        if (!wrap) return;
        if (!items.length){ wrap.innerHTML = '<div class="cloudMiniEmpty">Nenhum lead encontrado com estes filtros.</div>'; return; }
        var html = '<table><thead><tr><th>Nome</th><th>WhatsApp</th><th>Empresa</th><th>Origem</th></tr></thead><tbody>';
        items.slice(0, 8).forEach(function(lead){
          var phone = String(lead.whatsapp_digits || lead.whatsapp_raw || '').replace(/\D+/g, '');
          html += '<tr><td>' + escapeHtml(lead.nome || lead.name || '—') + '</td><td>' + escapeHtml(typeof formatWhatsAppPretty === 'function' ? formatWhatsAppPretty(phone) : phone) + '</td><td>' + escapeHtml(lead.empresa || lead.company || '—') + '</td><td>' + escapeHtml(lead.origem || lead.source || lead.detalhe_origem || '—') + '</td></tr>';
        });
        if (items.length > 8) html += '<tr><td colspan="4">Mostrando 8 de ' + items.length + '. Ao aplicar, todos os encontrados entram na campanha.</td></tr>';
        html += '</tbody></table>';
        wrap.innerHTML = html;
      } catch (error) {
        if (requestId !== cloudLeadPickerRequestId) return;
        cloudLeadPickerLastItems = [];
        if (count) count.innerHTML = '<i class="ph ph-warning"></i> Falha na consulta';
        if (wrap) wrap.innerHTML = '<div class="cloudMiniEmpty">' + escapeHtml(error.message || 'Não foi possível consultar os leads.') + '</div>';
      }
    }

    function cloudClearLeadPickerFilters(){
      ['cloudLeadFilterSearch','cloudLeadFilterDdd','cloudLeadFilterOrigin','cloudLeadFilterFrom','cloudLeadFilterTo'].forEach(function(id){ var el = document.getElementById(id); if (el) el.value = ''; });
      var st = document.getElementById('cloudLeadFilterStatus'); if (st) st.value = '';
      document.querySelectorAll('#cloudLeadFilterTags input[type="checkbox"]').forEach(function(ch){ ch.checked = false; });
      cloudRenderLeadPickerPreview();
    }

    async function cloudUseLeadPickerSelection(){
      try {
        var src = await cloudGetLeadPickerItems();
        var contacts = [];
        var seen = new Set();
        for (var i=0;i<src.length;i++){
          var lead = src[i] || {};
          var phone = String(lead.whatsapp_digits || lead.whatsapp_raw || lead.whatsapp || lead.phone || lead.telefone || '').replace(/\D+/g, '');
          if (!phone || phone.length < 8 || seen.has(phone)) continue;
          seen.add(phone);
          var leadName = lead.nome || lead.name || lead.empresa || lead.company || '';
          var leadCompany = lead.empresa || lead.company || '';
          var email = lead.email || '';
          contacts.push({
            to: phone,
            nome: leadName,
            personName: lead.nome || lead.name || '',
            companyName: leadCompany,
            email: email,
            varMap: { 1: leadName, 2: leadCompany || email },
            vars: [leadName, leadCompany || email].filter(function(x){ return String(x || '').trim(); }),
            source: 'filtered-leads'
          });
        }
        cloudContacts = contacts;
        renderCloudPreview();
        cloudCloseLeadPicker();
        toast('ok', 'Leads aplicados', cloudContacts.length + ' contato(s) prontos para o disparo.');
      } catch (error) {
        toast('err', 'Leads do painel', error.message || 'Não foi possível carregar todos os leads filtrados.');
      }
    }

    function cloudSelectedTemplateBodyVariableCount(){
      var selected = cloudSelectedTemplateObject();
      if (!selected || String(selected.status || '').toUpperCase() === 'MANUAL') return null;
      var comps = Array.isArray(selected.components) ? selected.components : [];
      var body = comps.find(function(c){ return String(c && c.type || '').toUpperCase() === 'BODY'; });
      var nums = extractNumericVarsFromText(body && body.text || '');
      if (!nums.length) return 0;
      return Math.max.apply(Math, nums);
    }

    function cloudVarsForSend(contact){
      var knownCount = cloudSelectedTemplateBodyVariableCount();
      var varMap = contact && contact.varMap ? contact.varMap : {};
      var rawVars = Array.isArray(contact && contact.vars) ? contact.vars : [];
      if (Number.isInteger(knownCount)){
        var out = [];
        for (var i=1;i<=knownCount;i++) out.push(String(varMap[i] || rawVars[i-1] || ''));
        return out;
      }
      return rawVars.map(function(v){ return String(v == null ? '' : v); });
    }

        function renderCloudPreview(){
      var wrap = document.getElementById("cloudPreview");
      var countEl = document.getElementById("cloudPreviewCount");
      if (!wrap || !countEl) return;
      countEl.textContent = String(cloudContacts.length || 0);
      if (!cloudContacts.length){
        wrap.innerHTML = '<div class="cloudEmptyState"><i class="ph ph-address-book-tabs"></i><div><b>Nenhum contato carregado</b><span>Importe uma planilha, escolha o papel de cada coluna e aplique o mapeamento.</span></div></div>';
        updateCloudUxState();
        return;
      }
      var limit = Math.min(cloudContacts.length, 12);
      var html = '';
      var knownVarCount = cloudSelectedTemplateBodyVariableCount();
      for (var i=0;i<limit;i++){
        var c = cloudContacts[i] || {};
        var phone = String(c.to || "").replace(/\D+/g, "");
        var pretty = typeof formatWhatsAppPretty === "function" ? formatWhatsAppPretty(phone) : phone;
        var vars = cloudVarsForSend(c).filter(function(v){ return String(v || "").trim(); });
        var meta = [];
        if (c.companyName) meta.push('Empresa: ' + c.companyName);
        if (c.personName && c.personName !== c.nome) meta.push('Pessoa: ' + c.personName);
        if (c.email) meta.push('E-mail: ' + c.email);
        html += '<div class="cloudContactRow">' +
          '<div class="cloudContactIndex">' + (i+1) + '</div>' +
          '<div class="cloudContactMain"><b>' + escapeHtml(c.nome || pretty || 'Contato') + '</b><span>' + escapeHtml(pretty || phone) + '</span>' +
          (meta.length ? '<div class="cloudContactMetaLine">' + meta.slice(0,3).map(function(m){ return '<em>' + escapeHtml(m) + '</em>'; }).join('') + '</div>' : '') + '</div>' +
          '<div class="cloudContactVars" title="' + escapeHtml(vars.join(' | ') || (knownVarCount === 0 ? 'Modelo sem variáveis' : 'Sem variáveis')) + '">' + escapeHtml(vars.length ? vars.join(' | ') : (knownVarCount === 0 ? 'Sem variáveis no modelo' : 'Sem variáveis')) + '</div>' +
        '</div>';
      }
      if (cloudContacts.length > limit){
        html += '<div class="cloudEmptyState" style="border-top:1px solid #f0f2f5;"><i class="ph ph-dots-three-circle"></i><div><b>Mostrando ' + limit + ' de ' + cloudContacts.length + '</b><span>O disparo envia todos os contatos carregados, não apenas os visíveis na prévia.</span></div></div>';
      }
      wrap.innerHTML = html;
      updateCloudUxState();
    }


    /* ---------- Hotfix modelos Meta: helpers, preview e UX state ---------- */
    function cloudSafeText(value, fallback){
      var str = String(value == null ? "" : value).trim();
      return str || (fallback || "—");
    }

    function cloudStatusKind(status){
      var s = String(status || "").toUpperCase();
      if (s === "APPROVED") return "approved";
      if (s === "REJECTED" || s === "DISABLED" || s === "PENDING_DELETION") return "rejected";
      if (s === "PAUSED" || s === "IN_APPEAL" || s === "APPEAL_REQUESTED") return "rejected";
      if (s === "LIBRARY") return "library";
      return "pending";
    }

    function cloudStatusLabel(status){
      return cloudTemplateStatusLabel(status);
    }

    function cloudTemplateComponents(t){
      return Array.isArray(t && t.components) ? t.components : [];
    }

    function cloudTemplateComponent(t, type){
      var want = String(type || "").toUpperCase();
      return cloudTemplateComponents(t).find(function(c){ return String(c && c.type || "").toUpperCase() === want; }) || null;
    }

    function cloudTemplateBodyPreview(t){
      var body = cloudTemplateComponent(t, "BODY");
      return cloudSafeText(body && body.text, "Modelo sem prévia de texto retornada pela Meta.");
    }

    function cloudSelectedTemplateObject(){
      var nameEl = document.getElementById("cloudTemplateName");
      var langEl = document.getElementById("cloudLanguage");
      var name = String(nameEl && nameEl.value || "").trim();
      var lang = String(langEl && langEl.value || "").trim();
      if (!name) return null;
      return (cloudTemplatesCache || []).find(function(t){
        return t && String(t.name || "") === name && (!lang || String(t.language || "") === lang);
      }) || { name: name, language: lang, status: "MANUAL", source: "manual" };
    }

    function cloudSetStepState(selector, state){
      var el = document.querySelector('#cloudProgressSteps [data-step="' + selector + '"]');
      if (!el) return;
      el.classList.remove("done", "current", "blocked");
      if (state) el.classList.add(state);
    }

    function getCloudBodyExamples(){
      var inputs = Array.from(document.querySelectorAll(".cloudBodyExample"));
      inputs.sort(function(a,b){ return Number(a.getAttribute("data-var")) - Number(b.getAttribute("data-var")); });
      return inputs.map(function(i){ return String(i.value || "").trim(); });
    }

    function updateCloudUxState(){
      var st = cloudStatusCache || {};
      var connected = !!st.configured;
      var templateEl = document.getElementById("cloudTemplateName");
      var langEl = document.getElementById("cloudLanguage");
      var templateName = String(templateEl && templateEl.value || "").trim();
      var languageCode = String(langEl && langEl.value || "").trim() || "pt_BR";
      var selected = cloudSelectedTemplateObject();
      var selectedStatus = String(selected && selected.status || "").toUpperCase();
      var selectedIsLibrary = selected && String(selected.source || "") === "library";
      var approvedKnown = selected && selectedStatus === "APPROVED" && !selectedIsLibrary;
      var hasTemplate = !!templateName;
      var hasContacts = Array.isArray(cloudContacts) && cloudContacts.length > 0;
      var ready = connected && approvedKnown && hasContacts;
      var approvedCount = (cloudTemplatesCache || []).filter(function(t){ return String(t && t.source || 'account') !== 'library' && String(t && t.status || "").toUpperCase() === "APPROVED"; }).length;

      var summary = document.getElementById("cloudQuickSummary");
      if (summary){
        summary.innerHTML = '' +
          '<div class="cloudMetric ' + (connected ? 'ok' : 'warn') + '"><span>Conexão</span><b>' + (connected ? 'Ativa' : 'Pendente') + '</b><small>' + escapeHtml(st.displayPhoneNumber || st.verifiedName || 'Vincule pela Meta') + '</small></div>' +
          '<div class="cloudMetric ' + (approvedKnown ? 'ok' : 'warn') + '"><span>Modelo</span><b>' + escapeHtml(hasTemplate ? templateName : 'Nenhum') + '</b><small>' + escapeHtml(hasTemplate ? (approvedKnown ? 'Aprovado na Meta' : 'Selecione um modelo aprovado da lista') : approvedCount + ' aprovado(s) encontrados') + '</small></div>' +
          '<div class="cloudMetric ' + (hasContacts ? 'ok' : 'warn') + '"><span>Contatos</span><b>' + (Array.isArray(cloudContacts) ? cloudContacts.length : 0) + '</b><small>' + (hasContacts ? 'Deduplicados e prontos' : 'Importe ou use leads filtrados') + '</small></div>' +
          '<div class="cloudMetric ' + (ready ? 'ok' : 'warn') + '"><span>Checklist</span><b>' + (ready ? 'Pronto' : 'Pendente') + '</b><small>' + (ready ? 'Pode revisar e enviar' : 'Faltam passos obrigatórios') + '</small></div>';
      }

      cloudSetStepState("connection", connected ? "done" : "current");
      cloudSetStepState("template", connected ? (approvedKnown ? "done" : "current") : "blocked");
      cloudSetStepState("contacts", connected && approvedKnown ? (hasContacts ? "done" : "current") : "blocked");
      cloudSetStepState("send", ready ? "current" : "blocked");

      var selectedCard = document.getElementById("cloudSelectedTemplateCard");
      if (selectedCard){
        selectedCard.classList.remove("ok", "warn");
        if (!hasTemplate){
          selectedCard.innerHTML = '<i class="ph ph-check-circle"></i><div><b>Nenhum modelo selecionado</b><span>Escolha um modelo aprovado na lista.</span></div>';
        } else if (approvedKnown){
          selectedCard.classList.add("ok");
          selectedCard.innerHTML = '<i class="ph ph-check-circle"></i><div><b>Modelo aprovado selecionado</b><span>' + escapeHtml(templateName) + ' • ' + escapeHtml(languageCode) + '</span></div>';
        } else if (selectedIsLibrary){
          selectedCard.classList.add("warn");
          selectedCard.innerHTML = '<i class="ph ph-books"></i><div><b>Modelo da biblioteca Meta</b><span>Use como base ou adicione à conta antes de enviar campanha.</span></div>';
        } else {
          selectedCard.classList.add("warn");
          selectedCard.innerHTML = '<i class="ph ph-warning-circle"></i><div><b>Modelo selecionado sem aprovação confirmada nesta lista</b><span>Confira se ele está aprovado na Meta antes de enviar. Nome: ' + escapeHtml(templateName) + ' • ' + escapeHtml(languageCode) + '</span></div>';
        }
      }

      var checklist = document.getElementById("cloudSendChecklist");
      if (checklist){
        function item(ok, title, text, warn){
          var cls = ok ? 'ok' : (warn ? 'warn' : 'err');
          var icon = ok ? 'ph-check-circle' : (warn ? 'ph-warning-circle' : 'ph-x-circle');
          return '<div class="cloudCheckItem ' + cls + '"><i class="ph ' + icon + '"></i><div><b>' + escapeHtml(title) + '</b><span>' + escapeHtml(text) + '</span></div></div>';
        }
        checklist.innerHTML = '' +
          item(connected, 'Conexão oficial', connected ? 'API vinculada e pronta.' : 'Vincule o WhatsApp oficial antes do disparo.') +
          item(approvedKnown, 'Modelo aprovado', approvedKnown ? 'Modelo aprovado encontrado na Meta.' : 'Escolha um modelo aprovado da lista da conta.', hasTemplate && !approvedKnown) +
          item(hasContacts, 'Contatos carregados', hasContacts ? cloudContacts.length + ' contato(s) prontos.' : 'Importe uma planilha ou use leads filtrados.') +
          item(ready, 'Envio', ready ? 'Tudo pronto para enviar.' : 'Finalize os itens pendentes antes de enviar.', true);
      }

      var badge = document.getElementById("cloudTotalPreviewBadge");
      if (badge) badge.textContent = (Array.isArray(cloudContacts) ? cloudContacts.length : 0) + " contato" + ((Array.isArray(cloudContacts) && cloudContacts.length === 1) ? "" : "s");
    }

    function cloudRenderWhatsappPreviewBubble(t){
      var header = cloudTemplateComponent(t, 'HEADER');
      var body = cloudTemplateComponent(t, 'BODY');
      var footer = cloudTemplateComponent(t, 'FOOTER');
      var buttons = cloudTemplateComponent(t, 'BUTTONS');
      var html = '<div class="cloudWaPhone"><div class="cloudWaScreen"><div class="cloudWaTopBar"><div class="cloudWaAvatar"><i class="ph ph-whatsapp-logo"></i></div><div><b>Empresa</b><span>prévia do modelo</span></div></div><div class="cloudWaChat"><div class="cloudWaBubble">';
      if (header && header.text) html += '<div class="cloudWaBubbleHeader">' + escapeHtml(header.text) + '</div>';
      html += '<div class="cloudWaBubbleBody">' + escapeHtml((body && body.text) || cloudTemplateBodyPreview(t)).replace(/\n/g, '<br>') + '</div>';
      if (footer && footer.text) html += '<div class="cloudWaBubbleFooter">' + escapeHtml(footer.text) + '</div>';
      html += '<div class="cloudWaBubbleTime">10:35 <i class="ph ph-checks"></i></div>';
      if (buttons && Array.isArray(buttons.buttons) && buttons.buttons.length){
        html += '<div class="cloudWaButtons">' + buttons.buttons.slice(0,3).map(function(b){ return '<div class="cloudWaButton"><i class="ph ph-cursor-click"></i> ' + escapeHtml(b.text || b.type || 'Botão') + '</div>'; }).join('') + '</div>';
      }
      html += '</div></div></div></div>';
      return html;
    }

    function cloudEnsureTemplatePreviewModal(){
      var modal = document.getElementById('cloudTemplatePreviewModal');
      if (modal) return modal;
      modal = document.createElement('div');
      modal.id = 'cloudTemplatePreviewModal';
      modal.className = 'cloudTemplatePreviewModal';
      modal.innerHTML = '<div class="cloudTemplatePreviewDialog" role="dialog" aria-modal="true">' +
        '<div class="cloudTemplatePreviewDialogHead"><div><b id="cloudTemplatePreviewTitle">Modelo</b><span>Visualize o conteúdo como mensagem do WhatsApp e confira os componentes retornados pela Meta.</span></div><button class="btn btnGhost" type="button" id="cloudCloseTemplatePreview"><i class="ph ph-x"></i> Fechar</button></div>' +
        '<div class="cloudTemplatePreviewDialogBody"><div id="cloudTemplatePreviewVisual"></div><div id="cloudTemplatePreviewDetails" class="cloudTemplatePreviewInfo"></div></div>' +
      '</div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function(ev){ if (ev.target === modal) modal.classList.remove('open'); });
      var close = modal.querySelector('#cloudCloseTemplatePreview');
      if (close) close.addEventListener('click', function(){ modal.classList.remove('open'); });
      return modal;
    }

    function cloudOpenTemplatePreview(index){
      var t = cloudTemplatesCache[Number(index)];
      if (!t) return;
      var modal = cloudEnsureTemplatePreviewModal();
      var title = modal.querySelector('#cloudTemplatePreviewTitle');
      var visual = modal.querySelector('#cloudTemplatePreviewVisual');
      var details = modal.querySelector('#cloudTemplatePreviewDetails');
      if (title) title.textContent = t.name || 'Modelo';
      if (visual) visual.innerHTML = cloudRenderWhatsappPreviewBubble(t);
      if (details) {
        var key = cloudIsLibraryTemplate(t) ? cloudLibraryCategoryKey(t) : String(t.category || 'OUTROS').toUpperCase();
        var info = cloudLibraryCategoryInfo(key);
        var bodyText = cloudTemplateBodyPreview(t);
        var vars = cloudTemplateVariableNumbers(t);
        var examples = cloudTemplateExampleValues(t);
        var buttons = cloudTemplateComponent(t, 'BUTTONS');
        var buttonItems = buttons && Array.isArray(buttons.buttons) ? buttons.buttons : [];
        var meta = '<div class="cloudTemplateMeta">' +
          '<span class="cloudTemplatePill ' + (cloudStatusKind(t.status) === 'approved' ? 'ok' : cloudStatusKind(t.status) === 'rejected' ? 'err' : 'warn') + '">' + escapeHtml(cloudStatusLabel(t.status)) + '</span>' +
          '<span class="cloudTemplatePill">' + escapeHtml(t.language || '—') + '</span>' +
          '<span class="cloudTemplatePill">' + escapeHtml(t.category || '—') + '</span>' +
          (cloudIsLibraryTemplate(t) ? '<span class="cloudTemplatePill">Biblioteca Meta</span>' : '') +
          '</div>';
        var varsHtml = vars.length
          ? '<div class="cloudTemplatePreviewVarGrid">' + vars.map(function(n, i){ return '<span>{{' + n + '}}' + (examples[i] ? ' · ' + escapeHtml(examples[i]) : '') + '</span>'; }).join('') + '</div>'
          : '<div class="cloudTemplatePreviewVarGrid"><em>Este modelo não exige variáveis obrigatórias.</em></div>';
        var buttonsHtml = buttonItems.length
          ? '<div class="cloudTemplatePreviewButtonList">' + buttonItems.slice(0,3).map(function(b){ return '<span><i class="ph ph-cursor-click"></i>' + escapeHtml(b.text || b.type || 'Botão') + '</span>'; }).join('') + '</div>'
          : '<p>Sem botões configurados neste modelo.</p>';
        details.innerHTML = '<div class="cloudTemplatePreviewCleanInfo">' + meta +
          '<div class="cloudTemplatePreviewInfoBlock"><h4>Categoria</h4><p><i class="ph ' + escapeHtml(info.icon) + '"></i> ' + escapeHtml(info.label) + '</p></div>' +
          '<div class="cloudTemplatePreviewInfoBlock"><h4>Mensagem</h4><p>' + escapeHtml(bodyText) + '</p></div>' +
          '<div class="cloudTemplatePreviewInfoBlock"><h4>Variáveis para preencher</h4>' + varsHtml + '</div>' +
          '<div class="cloudTemplatePreviewInfoBlock"><h4>Botões</h4>' + buttonsHtml + '</div>' +
          (cloudIsLibraryTemplate(t) ? '<div class="cloudTemplateLibraryBox"><b>Como usar</b>Use como base para editar o texto ou clique em Adicionar à conta para criar este modelo dentro da sua WABA.</div>' : '') +
          '</div>';
      }
      modal.classList.add('open');
    }

    function cloudUseLibraryTemplateAsBase(index){
      var t = cloudTemplatesCache[Number(index)];
      if (!t) return;
      var newName = cleanCloudTemplateName((t.name || 'modelo_meta') + '_bob');
      var header = cloudTemplateComponent(t, 'HEADER');
      var body = cloudTemplateComponent(t, 'BODY');
      var footer = cloudTemplateComponent(t, 'FOOTER');
      var buttons = cloudTemplateComponent(t, 'BUTTONS');
      var nameEl = document.getElementById('cloudNewTemplateName');
      var catEl = document.getElementById('cloudTemplateCategory');
      var langEl = document.getElementById('cloudTemplateLanguage');
      var headerEl = document.getElementById('cloudTemplateHeader');
      var bodyEl = document.getElementById('cloudTemplateBody');
      var footerEl = document.getElementById('cloudTemplateFooter');
      var buttonText = document.getElementById('cloudTemplateButtons');
      if (nameEl) nameEl.value = newName;
      if (catEl) catEl.value = t.category || 'UTILITY';
      if (langEl) langEl.value = t.language || 'pt_BR';
      if (headerEl) headerEl.value = header && header.text || '';
      if (bodyEl) bodyEl.value = body && body.text || cloudTemplateBodyPreview(t);
      if (footerEl) footerEl.value = footer && footer.text || '';
      if (buttonText && buttons && Array.isArray(buttons.buttons)) buttonText.value = buttons.buttons.map(function(b){ return b.text || ''; }).filter(Boolean).join('\n');
      renderHeaderExampleInput();
      renderBodyExampleInputs();
      updateCloudButtonRows();
      renderCloudCreateTemplatePreview();
      toast('ok', 'Modelo carregado', 'A biblioteca foi copiada para o formulário. Revise e envie para aprovação.');
    }

    async function cloudCreateTemplateFromLibrary(index){
      var t = cloudTemplatesCache[Number(index)];
      if (!t) return;
      var suggestedName = cleanCloudTemplateName((t.name || 'modelo_meta') + '_bob');
      var ok = await uiConfirm('Adicionar modelo à conta?', 'O modelo da biblioteca será enviado para a sua WABA com o nome "' + suggestedName + '". Depois ele pode aparecer como aprovado ou em análise pela Meta.', { okText: 'Adicionar à conta', icon: 'ph-plus-circle' });
      if (!ok) return;
      var log = document.getElementById('cloudLog');
      if (log) log.innerHTML = '<div class="cloudResultCard"><b>Adicionando modelo da biblioteca...</b><p class="cloudHelp">Enviando solicitação para a Meta.</p></div>';
      try{
        var payload = {
          name: suggestedName,
          libraryTemplateName: t.libraryTemplateName || t.name,
          category: t.category || 'UTILITY',
          language: t.language || 'pt_BR',
          allowCategoryChange: true
        };
        var r = await cloudFetch('/api/wa-cloud/templates', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
        var j = await r.json();
        if (!r.ok) throw new Error(normalizeCloudApiError(r.status, j, 'Falha ao adicionar modelo da biblioteca'));
        if (log) log.innerHTML = '<div class="cloudResultCard ok"><b>Modelo adicionado à conta</b><p class="cloudHelp">Atualize a lista para conferir o status retornado pela Meta.</p><details class="cloudTechnicalDetails"><summary>Ver retorno técnico</summary><pre>' + escapeHtml(JSON.stringify(j, null, 2)) + '</pre></details></div>';
        document.getElementById('cloudTemplateName').value = suggestedName;
        document.getElementById('cloudLanguage').value = payload.language;
        try{ localStorage.setItem('cloudLastTemplateSubmitted', JSON.stringify({ name: suggestedName, language: payload.language, submittedAt: new Date().toISOString() })); }catch(_){ }
        updateCloudUxState();
        setTimeout(function(){ cloudListTemplates().catch(function(){}); }, 900);
        toast('ok', 'Modelo enviado', 'Modelo da biblioteca adicionado à conta.');
      }catch(e){
        var msg = e && e.message ? e.message : String(e);
        if (log) log.innerHTML = '<div class="cloudResultCard err"><b>Não foi possível adicionar</b><p class="cloudHelp">' + escapeHtml(msg) + '</p></div>';
        toast('err', 'Biblioteca Meta', msg, 6500);
      }
    }


    function cloudIsLibraryTemplate(t){
      return String(t && t.source || '') === 'library';
    }

    function cloudAccountTemplates(){
      return (cloudTemplatesCache || []).filter(function(t){ return !cloudIsLibraryTemplate(t); });
    }

    function cloudApprovedAccountTemplates(){
      return cloudAccountTemplates().filter(function(t){
        return String(t && t.status || '').toUpperCase() === 'APPROVED' && String(t && t.name || '').trim();
      }).sort(function(a,b){
        var an = String(a.name || '').toLowerCase();
        var bn = String(b.name || '').toLowerCase();
        if (an !== bn) return an.localeCompare(bn);
        return String(a.language || '').localeCompare(String(b.language || ''));
      });
    }

    function cloudTemplateSelectKey(t){
      if (!t) return '';
      return String(t.name || '').trim() + '||' + String(t.language || '').trim();
    }

    function cloudFindTemplateBySelectKey(key){
      key = String(key || '');
      if (!key) return null;
      return cloudApprovedAccountTemplates().find(function(t){ return cloudTemplateSelectKey(t) === key; }) || null;
    }

    function cloudSetTemplateSelectLoading(text){
      var select = document.getElementById('cloudTemplateSelect');
      if (!select) return;
      select.innerHTML = '<option value="">' + escapeHtml(text || 'Carregando modelos aprovados...') + '</option>';
      select.disabled = true;
    }

    function cloudApplySelectedTemplate(t, opts){
      opts = opts || {};
      var nameEl = document.getElementById('cloudTemplateName');
      var langEl = document.getElementById('cloudLanguage');
      var select = document.getElementById('cloudTemplateSelect');
      if (!t){
        if (nameEl) nameEl.value = '';
        if (langEl) langEl.value = 'pt_BR';
        if (select) select.value = '';
      } else {
        if (nameEl) nameEl.value = t.name || '';
        if (langEl) langEl.value = t.language || 'pt_BR';
        if (select) select.value = cloudTemplateSelectKey(t);
      }
      if (!opts.silentToast && t) toast('ok', 'Modelo selecionado', (t.name || 'Template') + ' pronto para envio');
      if (!opts.skipPreview) renderCloudPreview();
      updateCloudUxState();
    }

    function cloudSyncTemplateSelect(){
      var select = document.getElementById('cloudTemplateSelect');
      if (!select) return;
      var nameEl = document.getElementById('cloudTemplateName');
      var langEl = document.getElementById('cloudLanguage');
      var currentKey = String(nameEl && nameEl.value || '').trim() ? (String(nameEl.value || '').trim() + '||' + String(langEl && langEl.value || '').trim()) : '';
      var approved = cloudApprovedAccountTemplates();
      if (!approved.length){
        select.innerHTML = '<option value="">Nenhum modelo aprovado encontrado</option>';
        select.disabled = true;
        if (nameEl) nameEl.value = '';
        if (langEl) langEl.value = 'pt_BR';
        return;
      }
      select.disabled = false;
      var html = '<option value="">Selecione um modelo aprovado</option>';
      approved.forEach(function(t){
        var label = (t.name || 'Modelo') + ' · ' + (t.language || '—') + (t.category ? ' · ' + t.category : '');
        html += '<option value="' + escapeHtml(cloudTemplateSelectKey(t)) + '">' + escapeHtml(label) + '</option>';
      });
      select.innerHTML = html;
      var selected = cloudFindTemplateBySelectKey(currentKey);
      if (selected){
        select.value = currentKey;
      } else {
        if (nameEl) nameEl.value = '';
        if (langEl) langEl.value = 'pt_BR';
        select.value = '';
      }
    }

    function cloudThrottleRangeFromControl(){
      var el = document.getElementById('cloudThrottle');
      var raw = String(el && el.value || '500:1200');
      var parts = raw.split(':').map(function(x){ return Number(x); });
      var min = Number.isFinite(parts[0]) ? Math.max(0, parts[0]) : 500;
      var max = Number.isFinite(parts[1]) ? Math.max(0, parts[1]) : min;
      if (max < min){ var tmp = min; min = max; max = tmp; }
      return { minMs: min, maxMs: max, mode: max > min ? 'random' : 'fixed' };
    }

    function cloudThrottleRangeLabel(range){
      range = range || cloudThrottleRangeFromControl();
      if (!range.maxMs) return 'sem intervalo';
      if (range.maxMs === range.minMs) return String(range.minMs) + 'ms fixo';
      return 'aleatório entre ' + String(range.minMs) + 'ms e ' + String(range.maxMs) + 'ms';
    }

    function cloudLibraryTemplates(){
      return (cloudTemplatesCache || []).filter(function(t){ return cloudIsLibraryTemplate(t); });
    }

    function cloudLibraryCategoryKey(t){
      var raw = String((t && (t.topic || t.usecase || t.industry || t.category)) || 'OUTROS').trim().toUpperCase();
      raw = raw.replace(/\s+/g, '_');
      return raw || 'OUTROS';
    }

    function cloudLibraryCategoryInfo(value){
      var key = String(value || 'OUTROS').toUpperCase();
      var map = {
        ALL: { label:'Todos', icon:'ph-squares-four', desc:'Todos os modelos pré-aprovados carregados.' },
        MARKETING: { label:'Marketing', icon:'ph-megaphone', desc:'Mensagens para campanhas, ofertas, relacionamento e comunicação comercial.' },
        UTILITY: { label:'Utilidade', icon:'ph-wrench', desc:'Atualizações transacionais e comunicações úteis para o cliente.' },
        AUTHENTICATION: { label:'Autenticação', icon:'ph-key', desc:'Códigos, validações, login e confirmação de identidade.' },
        PAYMENTS: { label:'Pagamentos', icon:'ph-credit-card', desc:'Cobranças, lembretes, confirmações e status de pagamento.' },
        ORDER_MANAGEMENT: { label:'Pedidos', icon:'ph-package', desc:'Status de pedido, entrega, confirmação e acompanhamento de compra.' },
        APPOINTMENT_UPDATE: { label:'Agendamentos', icon:'ph-calendar-check', desc:'Confirmações, lembretes e alterações de horário.' },
        APPOINTMENTS: { label:'Agendamentos', icon:'ph-calendar-check', desc:'Confirmações, lembretes e alterações de horário.' },
        ACCOUNT_UPDATE: { label:'Conta do cliente', icon:'ph-user-gear', desc:'Alterações cadastrais, conta, senha e dados do cliente.' },
        ALERT_UPDATE: { label:'Alertas', icon:'ph-bell-ringing', desc:'Avisos importantes, atualizações e notificações de status.' },
        ISSUE_RESOLUTION: { label:'Suporte', icon:'ph-lifebuoy', desc:'Atendimento, solução de problemas e atualização de chamados.' },
        RESERVATION_UPDATE: { label:'Reservas', icon:'ph-ticket', desc:'Reservas, confirmações e alterações de reserva.' },
        TICKET_UPDATE: { label:'Ingressos', icon:'ph-ticket', desc:'Ingressos, eventos, check-in e atualizações relacionadas.' },
        TRANSPORTATION_UPDATE: { label:'Transporte', icon:'ph-truck', desc:'Envio, transporte, logística e deslocamento.' },
        DELIVERY_UPDATE: { label:'Entregas', icon:'ph-truck', desc:'Rastreamento, previsão de entrega e status logístico.' },
        SHIPPING: { label:'Envios', icon:'ph-truck', desc:'Rastreamento, envio e logística.' },
        OUTROS: { label:'Outros', icon:'ph-dots-three-circle', desc:'Modelos sem categoria específica retornada pela Meta.' }
      };
      if (map[key]) return map[key];
      var label = key.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, function(c){ return c.toUpperCase(); });
      var lower = key.toLowerCase();
      var icon = 'ph-chat-circle-text';
      if (/PAY|PAYMENT|PAGAMENTO/.test(key)) icon = 'ph-credit-card';
      else if (/ORDER|PEDIDO|DELIVERY|SHIPPING|ENTREGA/.test(key)) icon = 'ph-package';
      else if (/APPOINT|SCHEDULE|AGENDA/.test(key)) icon = 'ph-calendar-check';
      else if (/AUTH|LOGIN|CODE|OTP/.test(key)) icon = 'ph-key';
      else if (/ALERT|WARNING|NOTICE/.test(key)) icon = 'ph-bell-ringing';
      else if (/SUPPORT|ISSUE|HELP/.test(key)) icon = 'ph-lifebuoy';
      else if (/MARKETING|PROMO/.test(key)) icon = 'ph-megaphone';
      return { label: label, icon: icon, desc: 'Modelos pré-aprovados relacionados a ' + label.toLowerCase() + '.' };
    }

    function cloudLibraryCategoryLabel(value){
      return cloudLibraryCategoryInfo(value).label;
    }

    function cloudLibraryCategoryIcon(value){
      return cloudLibraryCategoryInfo(value).icon;
    }

    function cloudTemplateVariableNumbers(t){
      var text = '';
      cloudTemplateComponents(t).forEach(function(c){
        if (c && c.text) text += '\n' + c.text;
      });
      var nums = [];
      String(text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, function(_, n){
        n = Number(n);
        if (nums.indexOf(n) === -1) nums.push(n);
      });
      return nums.sort(function(a,b){ return a-b; });
    }

    function cloudTemplateExampleValues(t){
      var body = cloudTemplateComponent(t, 'BODY');
      var ex = body && body.example && Array.isArray(body.example.body_text) ? body.example.body_text : [];
      if (Array.isArray(ex[0])) return ex[0].map(function(x){ return String(x || ''); });
      return [];
    }

    function cloudUpdateTemplateTabs(){
      var accountCount = cloudAccountTemplates().length;
      var libraryItems = cloudLibraryTemplates();
      var libraryCount = libraryItems.length;
      var aCount = document.getElementById('cloudAccountTemplateCount');
      var lCount = document.getElementById('cloudLibraryTemplateCount');
      if (aCount) aCount.textContent = String(accountCount);
      if (lCount) lCount.textContent = String(libraryCount);
      var help = document.getElementById('cloudTemplateBoxHelp');
      if (help) help.textContent = 'Modelos da sua conta/WABA. Use esta lista para escolher o modelo do disparo.';
      var filter = document.getElementById('cloudTemplateFilter');
      if (filter) filter.style.display = '';
    }

    function cloudRenderLibraryCategoryBar(items){
      return cloudRenderPremiumLibraryCategoryBar(items);
    }

    function cloudRenderPremiumLibraryCategoryBar(items){
      var bar = document.getElementById('cloudLibraryPremiumCategoryBar');
      if (!bar) return;
      var counts = {};
      (items || []).forEach(function(t){
        var key = cloudLibraryCategoryKey(t);
        counts[key] = (counts[key] || 0) + 1;
      });
      var keys = Object.keys(counts).sort(function(a,b){ return cloudLibraryCategoryLabel(a).localeCompare(cloudLibraryCategoryLabel(b)); });
      var total = (items || []).length;
      var html = '<button type="button" class="' + (cloudLibraryActiveCategory === 'all' ? 'active' : '') + '" data-cloud-library-category="all"><i class="ph ph-squares-four"></i>Todos <span>' + total + '</span></button>';
      keys.forEach(function(key){
        var info = cloudLibraryCategoryInfo(key);
        html += '<button type="button" class="' + (cloudLibraryActiveCategory === key ? 'active' : '') + '" data-cloud-library-category="' + escapeHtml(key) + '"><i class="ph ' + escapeHtml(info.icon) + '"></i>' + escapeHtml(info.label) + ' <span>' + counts[key] + '</span></button>';
      });
      bar.innerHTML = html;
      bar.querySelectorAll('[data-cloud-library-category]').forEach(function(btn){
        btn.addEventListener('click', function(){
          cloudLibraryActiveCategory = btn.getAttribute('data-cloud-library-category') || 'all';
          renderCloudTemplatesList();
        });
      });
    }

    function cloudTemplateMatchesSearch(t, search){
      var name = String(t && t.name || '').toLowerCase();
      var lang = String(t && t.language || '').toLowerCase();
      var body = cloudTemplateBodyPreview(t).toLowerCase();
      var topic = String(t && (t.topic || t.usecase || t.industry || t.category || '') || '').toLowerCase();
      return !search || name.indexOf(search) >= 0 || lang.indexOf(search) >= 0 || body.indexOf(search) >= 0 || topic.indexOf(search) >= 0;
    }

    function cloudBindTemplateCardActions(list){
      if (!list) return;
      list.querySelectorAll('[data-cloud-preview-template]').forEach(function(btn){
        btn.addEventListener('click', function(){ cloudOpenTemplatePreview(btn.getAttribute('data-cloud-preview-template')); });
      });
      list.querySelectorAll('[data-cloud-library-base]').forEach(function(btn){
        btn.addEventListener('click', function(){ cloudUseLibraryTemplateAsBase(btn.getAttribute('data-cloud-library-base')); });
      });
      list.querySelectorAll('[data-cloud-library-create]').forEach(function(btn){
        btn.addEventListener('click', function(){ cloudCreateTemplateFromLibrary(btn.getAttribute('data-cloud-library-create')); });
      });
      list.querySelectorAll('[data-cloud-use-template]').forEach(function(btn){
        btn.addEventListener('click', function(){
          var t = cloudTemplatesCache[Number(btn.getAttribute('data-cloud-use-template'))];
          if (!t) return;
          if (cloudIsLibraryTemplate(t) || String(t.status || '').toUpperCase() !== 'APPROVED'){
            toast('warn', 'Modelo não disponível', 'Só é possível selecionar modelos aprovados da conta.');
            return;
          }
          cloudApplySelectedTemplate(t);
        });
      });
    }

    function cloudTemplateCardHtml(t){
      var originalIndex = cloudTemplatesCache.indexOf(t);
      var kind = cloudStatusKind(t.status);
      var pillClass = kind === 'approved' ? 'ok' : kind === 'rejected' ? 'err' : 'warn';
      return '<div class="cloudTemplateCard ' + kind + '">' +
        '<div class="cloudTemplateCardTop"><div><b>' + escapeHtml(t.name || '') + '</b><div class="cloudTemplateMeta">' +
          '<span class="cloudTemplatePill ' + pillClass + '">' + escapeHtml(cloudStatusLabel(t.status)) + '</span>' +
          '<span class="cloudTemplatePill">' + escapeHtml(t.language || '—') + '</span>' +
          '<span class="cloudTemplatePill">' + escapeHtml(t.category || '—') + '</span>' +
        '</div></div></div>' +
        '<div class="cloudTemplatePreview">' + escapeHtml(cloudTemplateBodyPreview(t)) + '</div>' +
        (t.rejected_reason && t.rejected_reason !== 'NONE' ? '<div class="cloudCheckItem err"><i class="ph ph-x-circle"></i><div><b>Motivo da rejeição</b><span>' + escapeHtml(t.rejected_reason) + '</span></div></div>' : '') +
        '<div class="cloudTemplateActions"><button class="btn btnGhost" type="button" data-cloud-preview-template="' + originalIndex + '"><i class="ph ph-eye"></i> Visualizar</button>' +
        (kind === 'approved' ? '<button class="btn btnSoft" type="button" data-cloud-use-template="' + originalIndex + '"><i class="ph ph-check"></i> Selecionar</button>' : '<button class="btn btnGhost" type="button" disabled><i class="ph ph-lock"></i> Não aprovado</button>') + '</div>' +
      '</div>';
    }

    function cloudLibraryPremiumCardHtml(t){
      var originalIndex = cloudTemplatesCache.indexOf(t);
      var key = cloudLibraryCategoryKey(t);
      var info = cloudLibraryCategoryInfo(key);
      var vars = cloudTemplateVariableNumbers(t);
      var bodyText = cloudTemplateBodyPreview(t);
      var variableHtml = vars.length ? vars.slice(0,5).map(function(n){ return '<span>{{' + n + '}}</span>'; }).join('') : '<em>Sem variáveis obrigatórias</em>';
      if (vars.length > 5) variableHtml += '<span>+' + (vars.length - 5) + '</span>';
      return '<article class="cloudLibraryPremiumCard">' +
        '<div class="cloudLibraryPremiumCardTop">' +
          '<div class="cloudLibraryPremiumCardIcon"><i class="ph ' + escapeHtml(info.icon) + '"></i></div>' +
          '<div class="cloudLibraryPremiumCardTitle"><b>' + escapeHtml(t.name || 'Modelo Meta') + '</b><small>' + escapeHtml(info.label) + ' • ' + escapeHtml(t.language || '—') + '</small></div>' +
        '</div>' +
        '<div class="cloudLibraryPremiumBadges"><span class="primary"><i class="ph ph-seal-check"></i>Pré-aprovado</span><span>' + escapeHtml(t.category || '—') + '</span>' + (key ? '<span>' + escapeHtml(info.label) + '</span>' : '') + '</div>' +
        '<div class="cloudLibraryMiniPhone"><div class="cloudLibraryMiniBubble">' + escapeHtml(bodyText).replace(/\n/g,'<br>') + '</div></div>' +
        '<div class="cloudLibraryVars">' + variableHtml + '</div>' +
        '<div class="cloudLibraryPremiumCardActions">' +
          '<button class="btn btnGhost" type="button" data-cloud-preview-template="' + originalIndex + '"><i class="ph ph-eye"></i> Visualizar</button>' +
          '<button class="btn btnSoft" type="button" data-cloud-library-base="' + originalIndex + '"><i class="ph ph-pencil-simple"></i> Usar como base</button>' +
          '<button class="btn btnPrimary" type="button" data-cloud-library-create="' + originalIndex + '"><i class="ph ph-plus-circle"></i> Adicionar à conta</button>' +
        '</div>' +
      '</article>';
    }

    function cloudRenderPremiumLibrary(){
      var list = document.getElementById('cloudLibraryPremiumList');
      var searchEl = document.getElementById('cloudLibraryPremiumSearch');
      var langEl = document.getElementById('cloudLibraryPremiumLanguage');
      var libraryItems = cloudLibraryTemplates();
      var search = String(searchEl && searchEl.value || '').trim().toLowerCase();
      var selectedLang = String(langEl && langEl.value || '').trim() || 'pt_BR';
      var counts = {};
      libraryItems.forEach(function(t){ counts[cloudLibraryCategoryKey(t)] = true; });
      cloudRenderPremiumLibraryCategoryBar(libraryItems);
      var filtered = libraryItems.filter(function(t){
        var matchesCategory = cloudLibraryActiveCategory === 'all' || cloudLibraryCategoryKey(t) === cloudLibraryActiveCategory;
        return matchesCategory && cloudTemplateMatchesSearch(t, search);
      });
      var totalEl = document.getElementById('cloudLibraryHeroTotal');
      var catEl = document.getElementById('cloudLibraryHeroCategories');
      var langHeroEl = document.getElementById('cloudLibraryHeroLanguage');
      var shownEl = document.getElementById('cloudLibraryHeroShown');
      if (totalEl) totalEl.textContent = String(libraryItems.length);
      if (catEl) catEl.textContent = String(Object.keys(counts).length);
      if (langHeroEl) langHeroEl.textContent = selectedLang;
      if (shownEl) shownEl.textContent = String(filtered.length);
      if (!list) return;
      if (!libraryItems.length){
        list.innerHTML = '<div class="cloudEmptyState"><i class="ph ph-books"></i><div><b>Biblioteca ainda não carregada</b><span>Clique em Atualizar biblioteca para buscar os modelos oficiais da Meta.</span></div></div>';
        return;
      }
      if (!filtered.length){
        list.innerHTML = '<div class="cloudEmptyState"><i class="ph ph-magnifying-glass"></i><div><b>Nenhum modelo encontrado</b><span>Limpe a busca ou escolha outra categoria.</span></div></div>';
        return;
      }
      var groups = {};
      filtered.forEach(function(t){
        var key = cloudLibraryCategoryKey(t);
        if (!groups[key]) groups[key] = [];
        groups[key].push(t);
      });
      var groupKeys = Object.keys(groups).sort(function(a,b){ return cloudLibraryCategoryLabel(a).localeCompare(cloudLibraryCategoryLabel(b)); });
      var html = groupKeys.map(function(key){
        var info = cloudLibraryCategoryInfo(key);
        var groupItems = groups[key];
        return '<section class="cloudLibraryPremiumGroup">' +
          '<div class="cloudLibraryPremiumGroupHead">' +
            '<div class="cloudLibraryPremiumGroupTitle"><div class="cloudLibraryPremiumGroupIcon"><i class="ph ' + escapeHtml(info.icon) + '"></i></div><div><b>' + escapeHtml(info.label) + '</b><span>' + escapeHtml(info.desc) + '</span></div></div>' +
            '<div class="cloudLibraryPremiumGroupCount">' + groupItems.length + ' modelo(s)</div>' +
          '</div>' +
          '<div class="cloudLibraryPremiumGrid">' + groupItems.slice(0,240).map(cloudLibraryPremiumCardHtml).join('') + '</div>' +
        '</section>';
      }).join('');
      if (filtered.length > 240) html += '<div class="hint">Mostrando parte dos modelos filtrados. Use a busca ou uma categoria para refinar.</div>';
      list.innerHTML = html;
      cloudBindTemplateCardActions(list);
    }

    function renderCloudTemplatesList(){
      var list = document.getElementById("cloudTemplatesList");
      renderCloudTemplateStatusPanel();
      cloudUpdateTemplateTabs();
      var search = String((document.getElementById("cloudTemplateSearch") || {}).value || "").trim().toLowerCase();
      var filter = String((document.getElementById("cloudTemplateFilter") || {}).value || "all");
      var accountItems = cloudAccountTemplates();
      if (list){
        if (!cloudTemplatesCache.length){
          list.innerHTML = '<div class="cloudEmptyState"><i class="ph ph-note"></i><div><b>Nenhum modelo carregado</b><span>Clique em atualizar para buscar seus modelos da conta.</span></div></div>';
        } else {
          var items = accountItems.filter(function(t){
            var status = cloudStatusKind(t && t.status);
            var matchesText = cloudTemplateMatchesSearch(t, search);
            var matchesFilter = filter === "all" || filter === status;
            return matchesText && matchesFilter;
          });
          if (!accountItems.length){
            list.innerHTML = '<div class="cloudEmptyState"><i class="ph ph-whatsapp-logo"></i><div><b>Nenhum modelo da conta carregado</b><span>Clique em Atualizar para consultar os modelos da sua WABA.</span></div></div>';
          } else if (!items.length){
            list.innerHTML = '<div class="cloudEmptyState"><i class="ph ph-magnifying-glass"></i><div><b>Nenhum modelo encontrado</b><span>Limpe a busca ou troque o filtro de status.</span></div></div>';
          } else {
            var html = items.slice(0, 120).map(cloudTemplateCardHtml).join('');
            if (items.length > 120) html += '<div class="hint">Mostrando 120 de ' + items.length + ' modelos filtrados.</div>';
            list.innerHTML = html;
            cloudBindTemplateCardActions(list);
          }
        }
      }
      cloudRenderPremiumLibrary();
      cloudSyncTemplateSelect();
      updateCloudUxState();
      renderCloudTemplateStatusPanel();
    }

    async function cloudListTemplates(){
      var list = document.getElementById("cloudTemplatesList");
      var log = document.getElementById("cloudLog");
      try{
        cloudSetTemplateSelectLoading('Carregando modelos aprovados...');
        if (list) list.innerHTML = '<div class="cloudEmptyState"><i class="ph ph-spinner-gap"></i><div><b>Buscando modelos</b><span>Consultando seus modelos da conta.</span></div></div>';
        var premiumList = document.getElementById('cloudLibraryPremiumList');
        if (premiumList) premiumList.innerHTML = '<div class="cloudEmptyState"><i class="ph ph-spinner-gap"></i><div><b>Buscando biblioteca</b><span>Consultando os modelos pré-aprovados da Meta.</span></div></div>';

        var st = await loadCloudStatus().catch(function(){ return cloudStatusCache || {}; });
        if (st && (st.needsRelink || (st.credentialSource && st.credentialSource.needsRelink))) {
          throw new Error("A conexão do painel está incompleta. Clique em Vincular WhatsApp novamente para salvar Token, WABA ID e Phone Number ID juntos.");
        }

        var r = await cloudFetch("/api/wa-cloud/templates?limit=1500");
        var j = await r.json();
        if (!r.ok) throw new Error(normalizeCloudApiError(r.status, j, "Falha ao listar modelos"));

        var accountTemplates = Array.isArray(j.data) ? j.data.map(function(t){ t.source = t.source || 'account'; return t; }) : [];
        var libraryTemplates = [];
        var libraryError = null;
        var libraryLang = String((document.getElementById('cloudLibraryPremiumLanguage') || {}).value || (document.getElementById('cloudLanguage') || {}).value || 'pt_BR').trim() || 'pt_BR';
        try{
          var libUrl = "/api/wa-cloud/template-library?language=" + encodeURIComponent(libraryLang) + "&limit=500";
          var libR = await cloudFetch(libUrl);
          var libJ = await libR.json();
          if (!libR.ok) throw new Error(normalizeCloudApiError(libR.status, libJ, "Falha ao listar biblioteca da Meta"));
          libraryTemplates = Array.isArray(libJ.data) ? libJ.data : [];
        }catch(libErr){
          libraryError = libErr && libErr.message ? libErr.message : String(libErr);
        }

        cloudTemplatesCache = accountTemplates.concat(libraryTemplates);
        renderCloudTemplatesList();
        var approvedCount = accountTemplates.filter(function(t){ return String(t.status || "").toUpperCase() === "APPROVED"; }).length;
        var pendingCount = accountTemplates.filter(function(t){ return ['PENDING','IN_REVIEW','PENDING_REVIEW'].indexOf(String(t.status || '').toUpperCase()) >= 0; }).length;
        if (log) log.innerHTML = '<div class="cloudResultCard ok"><b>Modelos atualizados</b><div class="cloudResultNumbers"><div><span>Conta</span><b>' + accountTemplates.length + '</b></div><div><span>Aprovados</span><b>' + approvedCount + '</b></div><div><span>Em análise</span><b>' + pendingCount + '</b></div><div><span>Biblioteca</span><b>' + libraryTemplates.length + '</b></div></div>' + (libraryError ? '<p class="cloudHelp">Biblioteca Meta não carregou nesta tentativa: ' + escapeHtml(libraryError) + '</p>' : '') + '</div>';
      }catch(e){
        var msg = e && e.message ? e.message : String(e);
        if (/token|sess[aã]o|session|logged out|invalid/i.test(msg)) {
          msg = "A conexão com a Meta foi invalidada. Clique em Vincular Facebook e WhatsApp novamente para gerar um novo token e carregar os modelos.";
        }
        if (list) list.innerHTML = '<div class="cloudResultCard err"><b>Não foi possível carregar os modelos</b><p class="cloudHelp">' + escapeHtml(msg) + '</p></div>';
        var premiumListErr = document.getElementById('cloudLibraryPremiumList');
        if (premiumListErr) premiumListErr.innerHTML = '<div class="cloudResultCard err"><b>Não foi possível carregar a biblioteca</b><p class="cloudHelp">' + escapeHtml(msg) + '</p></div>';
        if (log) log.innerHTML = '<div class="cloudResultCard err"><b>Erro ao atualizar modelos</b><p class="cloudHelp">' + escapeHtml(msg) + '</p></div>';
      }
      cloudSyncTemplateSelect();
      updateCloudUxState();
      renderCloudTemplateStatusPanel();
    }

    async function cloudCreateTemplate(){
      var nameInput = document.getElementById("cloudNewTemplateName");
      var cleanName = cleanCloudTemplateName(nameInput && nameInput.value);
      if (nameInput) nameInput.value = cleanName;
      var payload = {
        name: cleanName,
        category: document.getElementById("cloudTemplateCategory").value || "MARKETING",
        language: document.getElementById("cloudTemplateLanguage").value || "pt_BR",
        headerText: document.getElementById("cloudTemplateHeader").value || "",
        headerExample: document.getElementById("cloudTemplateHeaderExample").value || "",
        bodyText: document.getElementById("cloudTemplateBody").value || "",
        bodyExamples: getCloudBodyExamples(),
        footerText: document.getElementById("cloudTemplateFooter").value || "",
        quickReplyButtons: String(document.getElementById("cloudTemplateButtons").value || "").split(/\r?\n/).map(function(x){ return x.trim(); }).filter(Boolean),
        templateButtons: getCloudTemplateButtonsPayload(),
        allowCategoryChange: !!document.getElementById("cloudAllowCategoryChange").checked
      };
      if (!payload.name){ toast("err", "Modelo", "Informe o nome do modelo"); return; }
      if (!payload.bodyText.trim()){ toast("err", "Modelo", "Informe o corpo da mensagem"); return; }
      var log = document.getElementById("cloudLog");
      if (log) log.innerHTML = '<div class="cloudResultCard"><b>Enviando modelo para aprovação...</b><p class="cloudHelp">A Meta vai analisar o conteúdo antes de liberar o disparo.</p></div>';
      try{
        var r = await cloudFetch("/api/wa-cloud/templates", { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload) });
        var j = await r.json();
        if (!r.ok) throw new Error(normalizeCloudApiError(r.status, j, "Falha ao criar modelo"));
        if (log) log.innerHTML = '<div class="cloudResultCard ok"><b>Modelo enviado para aprovação</b><p class="cloudHelp">Assim que a Meta aprovar, ele poderá ser usado em campanhas.</p><details class="cloudTechnicalDetails"><summary>Ver retorno técnico</summary><pre>' + escapeHtml(JSON.stringify(j, null, 2)) + '</pre></details></div>';
        document.getElementById("cloudTemplateName").value = payload.name;
        document.getElementById("cloudLanguage").value = payload.language;
        updateCloudUxState();
        toast("ok", "Modelo enviado", "Acompanhe a aprovação na lista de modelos.", 4200);
        setTimeout(function(){ cloudListTemplates().catch(function(){}); }, 1200);
      }catch(e){
        if (log) log.innerHTML = '<div class="cloudResultCard err"><b>Modelo não enviado</b><p class="cloudHelp">' + escapeHtml(e && e.message ? e.message : String(e)) + '</p></div>';
        toast("err", "Modelo não enviado", e && e.message ? e.message : String(e), 5200);
      }
    }

    async function cloudPollCampaignJob(jobId, expectedTotal){
      var log = document.getElementById("cloudLog");
      var terminal = { completed:true, completed_with_errors:true, failed:true, canceled:true };
      for (var attempt=0; attempt<720; attempt++){
        var r = await cloudFetch("/api/wa-cloud/jobs/" + encodeURIComponent(jobId));
        var j = await r.json();
        if (!r.ok) throw new Error(normalizeCloudApiError(r.status, j, "Falha ao consultar campanha"));
        var job = j.job || {};
        var p = job.progress || {};
        if (log) log.innerHTML = '<div class="cloudResultCard' + (job.state === "completed" ? ' ok' : (job.state === "failed" || job.state === "completed_with_errors" ? ' err' : '')) + '"><b>Campanha: ' + escapeHtml(job.state || "queued") + '</b><p class="cloudHelp">Processados: ' + Number(p.processed || 0) + ' de ' + Number(p.total || expectedTotal || 0) + ' · Enviados: ' + Number(p.sent || 0) + ' · Falhas: ' + Number(p.failed || 0) + '</p><p class="cloudHelp">O processamento continua no servidor mesmo se esta tela for fechada.</p></div>';
        if (terminal[job.state]) return job;
        await new Promise(function(resolve){ setTimeout(resolve, 1000); });
      }
      throw new Error("A campanha continua em processamento. Consulte novamente em alguns instantes.");
    }

    async function cloudSendBatch(){
      var templateName = String(document.getElementById("cloudTemplateName").value || "").trim();
      var languageCode = String(document.getElementById("cloudLanguage").value || "pt_BR").trim();
      var throttleRange = cloudThrottleRangeFromControl();
      if (!templateName){ toast("err","Modelo","Escolha um modelo aprovado da lista"); return; }
      if (!cloudContacts.length){ toast("err","Contatos","Importe um CSV ou use os leads filtrados"); return; }
      var st = cloudStatusCache || {};
      if (!st.configured){
        var goNoConnection = await uiConfirm("Conexão oficial não confirmada", "O painel ainda não confirmou a conexão com a API oficial. Deseja tentar enviar mesmo assim?", { tone:"warn", okText:"Tentar mesmo assim", icon:"ph-warning-circle" });
        if (!goNoConnection) return;
      }
      var approved = cloudApprovedAccountTemplates().find(function(t){ return t && t.name === templateName && String(t.language || "") === languageCode; });
      if (!approved){
        toast("err", "Modelo", "Selecione um modelo aprovado existente na conta Meta antes de enviar.");
        return;
      }
      var total = cloudContacts.length;
      var okConfirm = await uiConfirm("Enviar campanha oficial?", "Serão enviados " + total + " contato(s) usando o modelo " + templateName + " com intervalo " + cloudThrottleRangeLabel(throttleRange) + ".", { okText: "Enviar campanha", icon: "ph-paper-plane-tilt" });
      if (!okConfirm) return;
      var log = document.getElementById("cloudLog");
      if (log) log.innerHTML = '<div class="cloudResultCard"><b>Enfileirando campanha...</b><p class="cloudHelp">O processamento continuará no servidor mesmo se esta tela for fechada.</p></div>';
      try{
        var outboundContacts = cloudContacts.map(function(c){
          var copy = Object.assign({}, c || {});
          copy.vars = cloudVarsForSend(c || {});
          return copy;
        });
        var r = await cloudFetch("/api/wa-cloud/send-template-batch", { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ templateName: templateName, languageCode: languageCode, throttleMinMs: throttleRange.minMs, throttleMaxMs: throttleRange.maxMs, throttleMode: throttleRange.mode, contacts: outboundContacts }) });
        var j = await r.json();
        if (!r.ok) throw new Error(normalizeCloudApiError(r.status, j, "Falha no envio"));
        var queuedJob = j.job || {};
        if (!queuedJob.id) throw new Error("O servidor não retornou o identificador do job.");
        toast("ok", j.duplicate ? "Campanha já estava na fila" : "Campanha enfileirada", "O processamento continuará em segundo plano.", 4200);
        var finishedJob = await cloudPollCampaignJob(queuedJob.id, total);
        var progress = finishedJob.progress || {};
        toast(Number(progress.failed || 0) ? "warn" : "ok", "Campanha finalizada", "Enviados: " + Number(progress.sent || 0) + ", falhas: " + Number(progress.failed || 0));
      }catch(e){
        if (log) log.innerHTML = '<div class="cloudResultCard err"><b>Não foi possível enviar</b><p class="cloudHelp">' + escapeHtml(e && e.message ? e.message : String(e)) + '</p></div>';
        toast("err","Cloud API", e && e.message ? e.message : String(e));
      }
    }

    async function cloudUseCurrentLeads(){
      var src;
      try { src = await fetchAllLeadPages(buildLeadQueryParams()); }
      catch (error) { toast("err", "Leads do painel", error.message || "Não foi possível carregar todos os leads."); return; }
      var contacts = [];
      var seen = new Set();
      for (var i=0;i<src.length;i++){
        var lead = src[i] || {};
        var phone = String(lead.whatsapp_digits || lead.whatsapp_raw || "").replace(/\D+/g, "");
        if (!phone || phone.length < 10 || seen.has(phone)) continue;
        seen.add(phone);
        var leadName = lead.nome || lead.name || "";
        var leadCompany = lead.empresa || lead.company || "";
        contacts.push({
          to: phone,
          nome: leadName,
          companyName: leadCompany,
          varMap: { 1: leadName, 2: leadCompany },
          vars: [leadName, leadCompany].filter(function(x){ return String(x || "").trim(); }),
          source: "filtered-leads"
        });
      }
      cloudContacts = contacts;
      renderCloudPreview();
      toast("ok", "Contatos carregados", cloudContacts.length + " lead(s) filtrados adicionados");
    }

    (function bindCloud(){
      var f = document.getElementById("cloudCsv");
      var btnSend = document.getElementById("btnCloudSend");
      var btnTpl = document.getElementById("btnCloudListTemplates");
      var btnTpl2 = document.getElementById("btnCloudRefreshTemplates");
      var btnTpl3 = document.getElementById("btnCloudRefreshTemplatesTop");
      var btnTpl4 = document.getElementById("btnCloudRefreshTemplatesBuilder");
      var btnTplLibrary = document.getElementById("btnCloudRefreshTemplatesLibrary");
      var btnCreate = document.getElementById("btnCloudCreateTemplate");
      var btnUseLeads = document.getElementById("btnCloudUseCurrentLeads");
      var btnClear = document.getElementById("btnCloudClearContacts");
      var btnLoadStatus = document.getElementById("btnCloudLoadStatus");
      var btnSaveEmbedded = document.getElementById("btnCloudSaveEmbeddedSettings");
      var btnEmbeddedSignup = document.getElementById("btnCloudEmbeddedSignup");
      var btnDisconnect = document.getElementById("btnCloudDisconnect");
      var btnCloudBack = document.getElementById("btnCloudBack");
      var btnApplyMapping = document.getElementById("btnCloudApplyMapping");
      var btnCancelImport = document.getElementById("btnCloudCancelImport");
      var btnSaveSheet = document.getElementById("btnCloudSaveSheet");
      var btnRefreshSavedSheets = document.getElementById("btnCloudRefreshSavedSheets");
      var btnOpenLeadPicker = document.getElementById("btnCloudOpenLeadPicker");
      var btnCloseLeadPicker = document.getElementById("btnCloudCloseLeadPicker");
      var btnLeadPickerPreview = document.getElementById("btnCloudLeadPickerPreview");
      var btnLeadPickerApply = document.getElementById("btnCloudLeadPickerApply");
      var btnLeadPickerClear = document.getElementById("btnCloudLeadPickerClear");
      var cloudLeadFilterTags = document.getElementById("cloudLeadFilterTags");
      var newName = document.getElementById("cloudNewTemplateName");
      var body = document.getElementById("cloudTemplateBody");
      var header = document.getElementById("cloudTemplateHeader");
      var tplSearch = document.getElementById("cloudTemplateSearch");
      var tplFilter = document.getElementById("cloudTemplateFilter");
      var libSearch = document.getElementById("cloudLibraryPremiumSearch");
      var libLang = document.getElementById("cloudLibraryPremiumLanguage");
      var btnLibClear = document.getElementById("btnCloudLibraryClearFilters");
      var tplTabAccount = document.getElementById("cloudTemplateTabAccount");
      var tplTabLibrary = document.getElementById("cloudTemplateTabLibrary");
      var sendTplSelect = document.getElementById("cloudTemplateSelect");
      var sendTplName = document.getElementById("cloudTemplateName");
      var sendTplLang = document.getElementById("cloudLanguage");
      var sendThrottle = document.getElementById("cloudThrottle");

      applyTenantCloudDefaults();

      if (btnSend) btnSend.addEventListener("click", cloudSendBatch);
      if (btnTpl) btnTpl.addEventListener("click", cloudListTemplates);
      if (btnTpl2) btnTpl2.addEventListener("click", cloudListTemplates);
      if (btnTpl3) btnTpl3.addEventListener("click", cloudListTemplates);
      if (btnTpl4) btnTpl4.addEventListener("click", cloudListTemplates);
      if (btnTplLibrary) btnTplLibrary.addEventListener("click", cloudListTemplates);
      if (btnCreate) btnCreate.addEventListener("click", cloudCreateTemplate);
      if (btnUseLeads) btnUseLeads.addEventListener("click", cloudOpenLeadPicker);
      if (btnClear) btnClear.addEventListener("click", function(){ cloudContacts = []; renderCloudPreview(); });
      if (btnLoadStatus) btnLoadStatus.addEventListener("click", function(){ loadCloudStatus().catch(function(e){ toast("err", "Status", e && e.message ? e.message : String(e)); }); });
      if (btnSaveEmbedded) btnSaveEmbedded.addEventListener("click", saveCloudEmbeddedSettings);
      if (btnEmbeddedSignup) btnEmbeddedSignup.addEventListener("click", launchCloudEmbeddedSignup);
      if (btnDisconnect) btnDisconnect.addEventListener("click", disconnectCloudEmbedded);
      if (btnCloudBack) btnCloudBack.addEventListener("click", function(){ setActiveNav("leads"); });
      if (btnApplyMapping) btnApplyMapping.addEventListener("click", cloudApplyImportMapping);
      if (btnCancelImport) btnCancelImport.addEventListener("click", cloudCancelImportMapping);
      if (btnSaveSheet) btnSaveSheet.addEventListener("click", cloudSaveCurrentSheet);
      if (btnRefreshSavedSheets) btnRefreshSavedSheets.addEventListener("click", cloudLoadSavedSheets);
      if (btnOpenLeadPicker) btnOpenLeadPicker.addEventListener("click", cloudOpenLeadPicker);
      if (btnCloseLeadPicker) btnCloseLeadPicker.addEventListener("click", cloudCloseLeadPicker);
      if (btnLeadPickerPreview) btnLeadPickerPreview.addEventListener("click", cloudRenderLeadPickerPreview);
      if (btnLeadPickerApply) btnLeadPickerApply.addEventListener("click", cloudUseLeadPickerSelection);
      if (btnLeadPickerClear) btnLeadPickerClear.addEventListener("click", cloudClearLeadPickerFilters);
      ['cloudLeadFilterSearch','cloudLeadFilterDdd','cloudLeadFilterOrigin','cloudLeadFilterFrom','cloudLeadFilterTo','cloudLeadFilterStatus'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', cloudRenderLeadPickerPreview);
      });
      if (cloudLeadFilterTags) cloudLeadFilterTags.addEventListener('change', cloudRenderLeadPickerPreview);
      if (newName) newName.addEventListener("blur", function(){ newName.value = cleanCloudTemplateName(newName.value); });
      if (body) body.addEventListener("input", renderBodyExampleInputs);
      if (header) header.addEventListener("input", renderHeaderExampleInput);
      ['cloudNewTemplateName','cloudTemplateCategory','cloudTemplateLanguage','cloudTemplateHeader','cloudTemplateHeaderExample','cloudTemplateBody','cloudTemplateFooter','cloudTemplateButtons','cloudButtonType1','cloudButtonText1','cloudButtonValue1','cloudButtonType2','cloudButtonText2','cloudButtonValue2','cloudButtonType3','cloudButtonText3','cloudButtonValue3'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function(){ updateCloudButtonRows(); renderCloudCreateTemplatePreview(); });
      });
      if (tplSearch) tplSearch.addEventListener("input", renderCloudTemplatesList);
      if (tplFilter) tplFilter.addEventListener("change", renderCloudTemplatesList);
      if (libSearch) libSearch.addEventListener("input", renderCloudTemplatesList);
      if (libLang) libLang.addEventListener("change", function(){ cloudLibraryActiveCategory = "all"; cloudListTemplates().catch(function(e){ toast("err", "Biblioteca", e && e.message ? e.message : String(e)); }); });
      if (btnLibClear) btnLibClear.addEventListener("click", function(){
        if (libSearch) libSearch.value = "";
        cloudLibraryActiveCategory = "all";
        renderCloudTemplatesList();
      });
      if (tplTabAccount) tplTabAccount.addEventListener("click", function(){ cloudTemplateActiveTab = "account"; renderCloudTemplatesList(); });
      if (tplTabLibrary) tplTabLibrary.addEventListener("click", function(){ cloudTemplateActiveTab = "library"; cloudLibraryActiveCategory = cloudLibraryActiveCategory || "all"; renderCloudTemplatesList(); });
      if (sendTplSelect) sendTplSelect.addEventListener("change", function(){ cloudApplySelectedTemplate(cloudFindTemplateBySelectKey(sendTplSelect.value), { silentToast: !sendTplSelect.value }); });
      if (sendTplName) sendTplName.addEventListener("input", function(){ renderCloudPreview(); updateCloudUxState(); });
      if (sendTplLang) sendTplLang.addEventListener("input", function(){ renderCloudPreview(); updateCloudUxState(); });
      if (sendThrottle) sendThrottle.addEventListener("change", updateCloudUxState);

      if (f){
        f.addEventListener("change", async function(){
          var file = f.files && f.files[0];
          if (!file) return;
          await cloudHandleImportFile(file);
        });
      }

      renderBodyExampleInputs();
      renderHeaderExampleInput();
      updateCloudButtonRows();
      renderCloudCreateTemplatePreview();
      renderCloudTemplateStatusPanel();
      renderCloudPreview();
      renderCloudTemplatesList();
      cloudLoadSavedSheets().catch(function(){});
    })();

    /* ---------- Boot ---------- */
    async function boot(){
      // filtros default
      readFiltersFromUI();

      try{ await fetchTags(); }catch{}
      await loadLeads(true);

      // WA
      try{ await refreshWhatsApp(); }catch{}
      try{ await refreshStats(); }catch{}

      setInterval(function(){ refreshWhatsApp().catch(function(){}); }, 2000);
      setInterval(function(){ refreshStats().catch(function(){}); }, 5000);
    }

    boot();
  

/* ---------- Mensagem padrão (template) ---------- */
const ovTemplate = document.getElementById("ovTemplate");
const btnOpenTemplate = document.getElementById("btnOpenTemplate");
const btnCloseTemplate = document.getElementById("btnCloseTemplate");


  // -------------------- Webhooks (entrada) --------------------
    var whSelect = document.getElementById("whSelect");
    var whNameInput = document.getElementById("whNameInput");
    var btnWebhookNew = document.getElementById("btnWebhookNew");
    var btnWebhookCopy = document.getElementById("btnWebhookCopy");
    var btnWebhookDelete = document.getElementById("btnWebhookDelete");
    var whInfo = document.getElementById("whInfo");
    var btnWebhookSave = document.getElementById("btnWebhookSave");
    var whMsgMeta = document.getElementById("whMsgMeta");
    var btnWebhookAddMsg = document.getElementById("btnWebhookAddMsg");
    var whMessagesList = document.getElementById("whMessagesList");
    var whExternalCrmEnabled = document.getElementById("whExternalCrmEnabled");
    var whExternalCrmFields = document.getElementById("whExternalCrmFields");
    var whExternalCrmPipeline = document.getElementById("whExternalCrmPipeline");
    var whExternalCrmStage = document.getElementById("whExternalCrmStage");
    var whExternalCrmSource = document.getElementById("whExternalCrmSource");
    var whExternalCrmStatus = document.getElementById("whExternalCrmStatus");
    var btnExternalCrmRefresh = document.getElementById("btnExternalCrmRefresh");

    var webhookItems = [];
    var webhooksLoadedOnce = false;
    var externalCrmCatalog = { ok:false, configured:false, pipelines:[], queue:{} };
    var externalCrmCatalogLoading = false;

    function addMessageTextarea(text) {
      if (!whMessagesList) return;
      var wrap = document.createElement("div");
      wrap.className = "whMessageItemWrap";
      var textarea = document.createElement("textarea");
      textarea.className = "input whMsgItem";
      textarea.placeholder = "Ex: Olá {{nome}}, tudo bem? Recebemos seu cadastro e já vamos falar com você.";
      textarea.value = text || "";
      var removeBtn = document.createElement("button");
      removeBtn.className = "btn btnGhost whMessageDelete";
      removeBtn.type = "button";
      removeBtn.title = "Remover mensagem";
      removeBtn.innerHTML = '<i class="ph ph-trash"></i>';
      removeBtn.addEventListener("click", function(){ wrap.remove(); });
      wrap.appendChild(textarea);
      wrap.appendChild(removeBtn);
      whMessagesList.appendChild(wrap);
    }

    if (btnWebhookAddMsg) {
      btnWebhookAddMsg.addEventListener("click", function() { addMessageTextarea(""); });
    }

    function webhookOptionLabel(w){
      var label = (w && (w.displayName || w.name || w.url)) ? String(w.displayName || w.name || w.url) : "Webhook";
      var url = w && w.url ? String(w.url) : "";
      if (url && label !== url) return label + " · " + url;
      return label;
    }

    function currentWebhookNameInput(){
      return whNameInput ? String(whNameInput.value || "").trim() : "";
    }

    function externalCrmTargetOf(webhook){
      var target = webhook && webhook.externalCrmTarget && webhook.externalCrmTarget.enabled !== false
        ? webhook.externalCrmTarget
        : null;
      return target || { enabled:false, pipelineId:"", stageId:"", source:"WhatsApp" };
    }

    function externalCrmPipelineById(id){
      var wanted = String(id || "");
      var pipelines = Array.isArray(externalCrmCatalog.pipelines) ? externalCrmCatalog.pipelines : [];
      return pipelines.find(function(p){ return String(p.id || "") === wanted; }) || null;
    }

    function populateExternalCrmStages(pipelineId, selectedStageId){
      if (!whExternalCrmStage) return;
      var wantedStage = String(selectedStageId || "");
      whExternalCrmStage.innerHTML = "";

      if (!pipelineId) {
        var defaultStageOption = document.createElement("option");
        defaultStageOption.value = "";
        defaultStageOption.textContent = "Etapa “Novo lead” padrão";
        whExternalCrmStage.appendChild(defaultStageOption);
        whExternalCrmStage.value = "";
        whExternalCrmStage.disabled = true;
        return;
      }

      var pipeline = externalCrmPipelineById(pipelineId);
      var stages = pipeline && Array.isArray(pipeline.stages) ? pipeline.stages : [];
      stages.forEach(function(stage){
        var option = document.createElement("option");
        option.value = String(stage.id || "");
        option.textContent = String(stage.name || "Etapa");
        whExternalCrmStage.appendChild(option);
      });

      if (wantedStage && !stages.some(function(stage){ return String(stage.id || "") === wantedStage; })) {
        var missingStage = document.createElement("option");
        missingStage.value = wantedStage;
        missingStage.textContent = "Etapa configurada não encontrada";
        whExternalCrmStage.appendChild(missingStage);
      }

      whExternalCrmStage.disabled = stages.length === 0 && !wantedStage;
      whExternalCrmStage.value = wantedStage || (stages[0] ? String(stages[0].id || "") : "");
    }

    function populateExternalCrmPipelines(target){
      if (!whExternalCrmPipeline) return;
      var wantedPipeline = String((target && target.pipelineId) || "");
      var wantedStage = String((target && target.stageId) || "");
      var pipelines = Array.isArray(externalCrmCatalog.pipelines) ? externalCrmCatalog.pipelines : [];
      whExternalCrmPipeline.innerHTML = "";

      var defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "Funil padrão do CRM";
      whExternalCrmPipeline.appendChild(defaultOption);

      pipelines.forEach(function(pipeline){
        var option = document.createElement("option");
        option.value = String(pipeline.id || "");
        option.textContent = String(pipeline.name || "Funil") + (pipeline.isDefault ? " · padrão" : "");
        whExternalCrmPipeline.appendChild(option);
      });

      if (wantedPipeline && !pipelines.some(function(pipeline){ return String(pipeline.id || "") === wantedPipeline; })) {
        var missingPipeline = document.createElement("option");
        missingPipeline.value = wantedPipeline;
        missingPipeline.textContent = "Funil configurado não encontrado";
        whExternalCrmPipeline.appendChild(missingPipeline);
      }

      whExternalCrmPipeline.value = wantedPipeline;
      populateExternalCrmStages(wantedPipeline, wantedStage);
    }

    function externalCrmQueueSummary(){
      var queue = externalCrmCatalog && externalCrmCatalog.queue ? externalCrmCatalog.queue : {};
      var pending = Number(queue.pending || 0) + Number(queue.sending || 0);
      var failed = Number(queue.failedPermanent || 0);
      var delivered = Number(queue.delivered || 0);
      var parts = [];
      if (pending) parts.push(pending + " pendente" + (pending === 1 ? "" : "s"));
      if (failed) parts.push(failed + " falha" + (failed === 1 ? " definitiva" : "s definitivas"));
      if (delivered) parts.push(delivered + " entregue" + (delivered === 1 ? "" : "s"));
      return parts.length ? parts.join(" · ") : "fila sem pendências";
    }

    function renderExternalCrmStatus(webhook){
      if (!whExternalCrmStatus) return;
      var enabled = Boolean(webhook && whExternalCrmEnabled && whExternalCrmEnabled.checked);
      var queueText = externalCrmQueueSummary();

      if (externalCrmCatalogLoading) {
        whExternalCrmStatus.innerHTML = "<strong>Consultando o CRM Inteligente...</strong>";
        return;
      }
      if (!externalCrmCatalog.configured) {
        var errorText = String(externalCrmCatalog.error || "Defina a URL e a chave da integração no servidor do WhatsApp.");
        whExternalCrmStatus.innerHTML = "<strong>Conexão ainda não configurada.</strong> " + escapeHtml(errorText);
        return;
      }
      if (externalCrmCatalog.ok === false) {
        whExternalCrmStatus.innerHTML = "<strong>Não foi possível consultar o CRM.</strong> " + escapeHtml(String(externalCrmCatalog.error || "Verifique a conexão.")) + " · " + escapeHtml(queueText);
        return;
      }
      if (!webhook) {
        whExternalCrmStatus.innerHTML = "<strong>Gere ou selecione um webhook.</strong> A integração é configurada separadamente para cada origem. · " + escapeHtml(queueText);
        return;
      }
      if (!enabled) {
        whExternalCrmStatus.innerHTML = "<strong>CRM conectado.</strong> Integração desativada neste webhook. · " + escapeHtml(queueText);
        return;
      }
      whExternalCrmStatus.innerHTML = "<strong>CRM conectado e ativo neste webhook.</strong> " + escapeHtml(queueText);
    }

    function renderExternalCrmUi(webhook){
      var target = externalCrmTargetOf(webhook);
      var enabled = Boolean(webhook && target.enabled);
      if (whExternalCrmEnabled) {
        whExternalCrmEnabled.checked = enabled;
        whExternalCrmEnabled.disabled = !webhook;
      }
      if (whExternalCrmFields) whExternalCrmFields.classList.toggle("is-disabled", !enabled || !webhook);
      populateExternalCrmPipelines(target);
      if (whExternalCrmSource) whExternalCrmSource.value = String(target.source || "WhatsApp");
      renderExternalCrmStatus(webhook);
    }

    async function loadExternalCrmCatalog(){
      if (externalCrmCatalogLoading) return externalCrmCatalog;
      externalCrmCatalogLoading = true;
      renderExternalCrmStatus(selectedWebhook());
      try {
        var response = await fetch(API_BASE + "/external-crm/catalog");
        var data = await response.json().catch(function(){ return {}; });
        externalCrmCatalog = {
          ok: Boolean(response.ok && data && data.ok !== false),
          configured: Boolean(data && data.configured),
          pipelines: data && Array.isArray(data.pipelines) ? data.pipelines : [],
          queue: data && data.queue ? data.queue : {},
          defaultPipelineId: data && data.defaultPipelineId ? String(data.defaultPipelineId) : "",
          error: data && (data.error || data.message) ? String(data.error || data.message) : "",
        };
      } catch(e) {
        externalCrmCatalog = {
          ok:false,
          configured:Boolean(externalCrmCatalog.configured),
          pipelines:Array.isArray(externalCrmCatalog.pipelines) ? externalCrmCatalog.pipelines : [],
          queue:externalCrmCatalog.queue || {},
          error:"Falha de conexão com o servidor do WhatsApp.",
        };
      } finally {
        externalCrmCatalogLoading = false;
        renderExternalCrmUi(selectedWebhook());
      }
      return externalCrmCatalog;
    }

    function renderWebhooks(){
      if (!whSelect) return;
      whSelect.innerHTML = "";
      if (!webhookItems.length){
        var opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "nenhum webhook (gere um)";
        whSelect.appendChild(opt);
      } else {
        webhookItems.forEach(function(w){
          var opt = document.createElement("option");
          opt.value = w.id;
          opt.textContent = webhookOptionLabel(w);
          whSelect.appendChild(opt);
        });
      }
      updateWebhookInfo();
    }

    function selectedWebhook(){
      var id = whSelect ? whSelect.value : "";
      return webhookItems.find(function(w){ return w.id === id; }) || null;
    }

    function updateWebhookInfo(){
      var w = selectedWebhook();
      if (!whInfo) return;
      if (whMessagesList) whMessagesList.innerHTML = ""; // Limpa a lista atual

      if (!w) {
        if (whNameInput) {
          whNameInput.value = "";
          whNameInput.placeholder = "Ex: Landing Lisboa, Formulário Hotmart, Lead Ads Maio";
        }
        whInfo.textContent = "Nenhum link ativo. Coloque um nome para a origem e clique em Gerar novo link.";
        addMessageTextarea(""); // Campo vazio padrão
        if (whMsgMeta) whMsgMeta.textContent = "";
      } else {
        if (whNameInput) {
          whNameInput.value = w.isNamed ? (w.name || w.displayName || "") : "";
          whNameInput.placeholder = w.isNamed ? "" : "Webhook antigo sem nome. Se quiser, digite um nome e salve.";
        }
        var originName = w.displayName || w.name || w.url || "Webhook";
        whInfo.textContent = "Origem nos insights: " + originName + ". Link ativo desde " + formatDate(w.createdAt) + ". Copie e use no formulário que vai enviar os cadastros para este painel.";
        if (whMsgMeta) whMsgMeta.textContent = w.updatedAt ? ("Última atualização: " + formatDate(w.updatedAt)) : "";
        
        // Puxa as mensagens novas, ou faz o fallback pro sistema antigo
        var msgs = (w.messages && w.messages.length > 0) ? w.messages : (w.messageText ? [w.messageText] : [""]);
        msgs.forEach(function(m) { addMessageTextarea(m); });
      }
      renderExternalCrmUi(w);
    }

    async function loadWebhooks(){
      try {
        var r = await fetch(API_BASE + "/webhooks").then(function(x){ return x.json(); });
        webhookItems = (r && r.webhooks) ? r.webhooks : [];
      } catch(e){
        webhookItems = [];
      }
      renderWebhooks();
    }

    if (whSelect) whSelect.addEventListener("change", updateWebhookInfo);
    if (whExternalCrmEnabled) whExternalCrmEnabled.addEventListener("change", function(){
      var enabled = Boolean(whExternalCrmEnabled.checked && selectedWebhook());
      if (whExternalCrmFields) whExternalCrmFields.classList.toggle("is-disabled", !enabled);
      renderExternalCrmStatus(selectedWebhook());
      if (enabled) {
        setTimeout(function(){
          var panel = document.querySelector("#ovTemplate .externalCrmPanel");
          if (panel && panel.scrollIntoView) panel.scrollIntoView({ block:"nearest", behavior:"smooth" });
        }, 80);
      }
    });
    if (whExternalCrmPipeline) whExternalCrmPipeline.addEventListener("change", function(){
      populateExternalCrmStages(whExternalCrmPipeline.value, "");
    });
    if (btnExternalCrmRefresh) btnExternalCrmRefresh.addEventListener("click", function(){
      loadExternalCrmCatalog();
    });

    if (btnWebhookNew) btnWebhookNew.addEventListener("click", async function(){
      try {
        var selected = selectedWebhook();
        var defaultName = currentWebhookNameInput();
        if (selected && selected.isNamed && defaultName === String(selected.name || selected.displayName || "").trim()) defaultName = "";
        var webhookName = await uiPrompt("Nome da origem", "Digite um nome para identificar este webhook nos Insights. Ex: Landing Lisboa, Formulário Hotmart ou Lead Ads Maio.", defaultName, { okText:"Gerar link", icon:"ph-tag" });
        webhookName = String(webhookName || "").trim();
        if (whNameInput && webhookName) whNameInput.value = webhookName;
        if (!webhookName) {
          toast("warn", "Entrada automática", "Dê um nome para este webhook antes de gerar o link.");
          return;
        }
        var r = await fetch(API_BASE + "/webhooks", {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ name: webhookName })
        }).then(function(x){ return x.json(); });
        if (r && r.ok){
          await loadWebhooks();
          if (whSelect && r.id) whSelect.value = r.id;
          else if (whSelect && webhookItems.length) whSelect.value = webhookItems[0].id;
          updateWebhookInfo();
          toast("ok", "Entrada automática", "Link gerado com origem: " + webhookName);
        } else {
          toast("err", "Entrada automática", (r && r.error) ? r.error : "Falha ao gerar webhook.");
        }
      } catch(e){
        toast("err", "Entrada automática", "Falha ao gerar webhook.");
      }
    });

    if (btnWebhookCopy) btnWebhookCopy.addEventListener("click", async function(){
      var w = selectedWebhook();
      if (!w) { toast("warn", "Entrada automática", "Nenhum link selecionado."); return; }
      try {
        await navigator.clipboard.writeText(w.url);
        toast("ok", "Link copiado", "Agora é só colar no formulário ou automação.");
      } catch(e){
        toast("warn", "Copiar link", "Não consegui copiar. Copie manualmente pelo campo do link.");
      }
    });

    if (btnWebhookDelete) btnWebhookDelete.addEventListener("click", async function(){
      var w = selectedWebhook();
      if (!w) { toast("warn", "Entrada automática", "Nenhum link selecionado."); return; }
      if (!(await uiConfirm("Excluir link de entrada?", "O link vai parar de funcionar e não receberá novos leads.", { tone: "danger", okText: "Excluir link", icon: "ph-trash" }))) return;
      try{
        var r = await fetch(API_BASE + "/webhooks/" + encodeURIComponent(w.id), { method:"DELETE" }).then(function(x){ return x.json(); });
        if (r && r.ok){
          await loadWebhooks();
        } else {
          toast("err", "Entrada automática", (r && r.error) ? r.error : "Falha ao excluir link.");
        }
      } catch(e){
        toast("err", "Entrada automática", "Falha ao excluir link.");
      }
    });


    if (btnWebhookSave) btnWebhookSave.addEventListener("click", async function(){
      var w = selectedWebhook();
      if (!w) { toast("warn", "Entrada automática", "Nenhum link selecionado."); return; }
      
      var textAreas = document.querySelectorAll(".whMsgItem");
      var messagesArray = [];
      textAreas.forEach(function(ta) {
          var t = ta.value.trim();
          if (t) messagesArray.push(t);
      });

      if (messagesArray.length === 0) {
        toast("warn", "Mensagens automáticas", "Adicione pelo menos uma mensagem. Se não quiser enviar nada, exclua este link de entrada."); return;
      }

      var prevLabel = btnWebhookSave.textContent;
      btnWebhookSave.disabled = true;
      btnWebhookSave.textContent = "Salvando...";
      if (whMsgMeta) whMsgMeta.textContent = "Salvando...";

      try{
        var webhookName = currentWebhookNameInput();
        var body = { messages: messagesArray };
        if (webhookName) body.name = webhookName;

        if (whExternalCrmEnabled && whExternalCrmEnabled.checked) {
          var pipelineId = whExternalCrmPipeline ? String(whExternalCrmPipeline.value || "") : "";
          var stageId = whExternalCrmStage ? String(whExternalCrmStage.value || "") : "";
          if (pipelineId && !stageId) {
            toast("warn", "CRM Inteligente", "Selecione a etapa inicial do funil escolhido.");
            if (whMsgMeta) whMsgMeta.textContent = "";
            return;
          }
          body.externalCrmTarget = {
            enabled: true,
            pipelineId: pipelineId,
            stageId: stageId,
            source: whExternalCrmSource ? String(whExternalCrmSource.value || "WhatsApp") : "WhatsApp"
          };
        } else {
          body.externalCrmTarget = null;
        }

        var r = await fetch(API_BASE + "/webhooks/" + encodeURIComponent(w.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }).then(function(x){ return x.json(); });

        if (r && r.ok && r.webhook){
          await loadWebhooks();
          if (whSelect) whSelect.value = r.webhook.id;
          updateWebhookInfo();
          toast("ok","Entrada automática","Origem, mensagens e integração salvas.");
        } else {
          toast("err", "Mensagens automáticas", (r && r.error) ? r.error : "Falha ao salvar mensagens.");
          if (whMsgMeta) whMsgMeta.textContent = "";
        }
      } catch(e){
        toast("err", "Mensagens automáticas", "Falha ao salvar mensagens.");
        if (whMsgMeta) whMsgMeta.textContent = "";
      } finally {
        btnWebhookSave.disabled = false;
        btnWebhookSave.textContent = prevLabel;
      }
    });

    btnOpenTemplate?.addEventListener("click", async () => {
      ovTemplate.classList.add("open");
      try {
        await Promise.allSettled([loadWebhooks(), loadExternalCrmCatalog()]);
        webhooksLoadedOnce = true;
      } catch(e) {}
    });
    btnCloseTemplate?.addEventListener("click", () => ovTemplate.classList.remove("open"));
    ovTemplate?.addEventListener("click", (e) => { if (e.target === ovTemplate) ovTemplate.classList.remove("open"); });

    /* ---------------- CRM (Funil de Vendas) ---------------- */
    var CRM_API_PREFIX = API_BASE;
    var crmState = null;
    var crmLeads = [];
    var crmLeadById = Object.create(null);
    var crmLoadedOnce = false;
    var crmSaving = false;
    var crmSaveTimer = null;

    var crmPipelinesBar = document.getElementById("crmPipelinesBar");
    var crmBoard = document.getElementById("crmBoard");

    var crmBtnNewPipeline = document.getElementById("crmBtnNewPipeline");
    var crmBtnNewStage = document.getElementById("crmBtnNewStage");
    var crmBtnImportLead = document.getElementById("crmBtnImportLead");
    var crmBtnBulkMode = document.getElementById("crmBtnBulkMode");
    var crmBtnLinkWebhook = document.getElementById("crmBtnLinkWebhook");
    var crmBtnNewLead = document.getElementById("crmBtnNewLead");
    var crmBulkToolbar = document.getElementById("crmBulkToolbar");
    var crmBulkMode = false;
    var crmSelectedLeadIds = Object.create(null);

    var CRM_STAGE_DRAG_TYPE = "application/x-zape-crm-stage";
    var CRM_LEAD_DRAG_TYPE = "application/x-zape-crm-lead";
    var crmDraggedStageId = null;
    var crmDraggedLeadIds = [];

    function crmDragHasType(e, type){
      var types = e && e.dataTransfer && e.dataTransfer.types;
      if (!types) return false;
      for (var i = 0; i < types.length; i++) {
        if (String(types[i]) === type) return true;
      }
      return false;
    }

    function crmClearStageDropHints(){
      if (!crmBoard) return;
      crmBoard.querySelectorAll(".crmStageDropBefore,.crmStageDropAfter").forEach(function(el){
        el.classList.remove("crmStageDropBefore", "crmStageDropAfter");
      });
    }

    function crmReorderStage(pipeline, fromStageId, toStageId, insertAfter){
      if (!pipeline || !Array.isArray(pipeline.stageOrder)) return false;
      fromStageId = String(fromStageId || "");
      toStageId = String(toStageId || "");
      if (!fromStageId || !toStageId || fromStageId === toStageId) return false;
      var order = pipeline.stageOrder.slice();
      var fromIndex = order.indexOf(fromStageId);
      var toIndex = order.indexOf(toStageId);
      if (fromIndex < 0 || toIndex < 0) return false;
      order.splice(fromIndex, 1);
      if (fromIndex < toIndex) toIndex--;
      var finalIndex = toIndex + (insertAfter ? 1 : 0);
      if (finalIndex < 0) finalIndex = 0;
      if (finalIndex > order.length) finalIndex = order.length;
      order.splice(finalIndex, 0, fromStageId);
      pipeline.stageOrder = order;
      return true;
    }

    var crmModalOverlay = document.getElementById("crmModalOverlay");
    var crmModalTitle = document.getElementById("crmModalTitle");
    var crmModalSub = document.getElementById("crmModalSub");
    var crmModalBody = document.getElementById("crmModalBody");
    var crmModalClose = document.getElementById("crmModalClose");

    function crmEnsureModal(){
      if (document.getElementById("crmModalOverlay")) return;
      var overlay = document.createElement("div");
      overlay.id = "crmModalOverlay";
      overlay.className = "crmModalOverlay";
      overlay.style.display = "none";
      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.background = "rgba(0,0,0,.5)";
      overlay.style.zIndex = "9999";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";

      var modal = document.createElement("div");
      modal.id = "crmModal";
      modal.className = "crmModal crmModalPremium";
      modal.style.background = "#fff";
      modal.style.width = "92%";
      modal.style.maxWidth = "760px";
      modal.style.maxHeight = "85vh";
      modal.style.overflow = "auto";
      modal.style.borderRadius = "12px";
      modal.style.boxShadow = "0 10px 30px rgba(0,0,0,.25)";

      var header = document.createElement("div");
      header.className = "crmModalHead";
      header.style.display = "flex";
      header.style.alignItems = "flex-start";
      header.style.justifyContent = "space-between";
      header.style.gap = "12px";
      header.style.padding = "14px 16px 10px 16px";
      header.style.borderBottom = "1px solid rgba(0,0,0,.08)";

      var titleWrap = document.createElement("div");
      titleWrap.style.minWidth = "0";

      var title = document.createElement("div");
      title.id = "crmModalTitle";
      title.style.fontWeight = "700";
      title.style.fontSize = "16px";
      title.style.lineHeight = "1.2";
      title.style.wordBreak = "break-word";

      var sub = document.createElement("div");
      sub.id = "crmModalSub";
      sub.style.opacity = "0.7";
      sub.style.marginTop = "4px";
      sub.style.fontSize = "13px";
      sub.style.wordBreak = "break-word";

      titleWrap.appendChild(title);
      titleWrap.appendChild(sub);

      var close = document.createElement("button");
      close.id = "crmModalClose";
      close.type = "button";
      close.innerHTML = iconMarkup("close", "Fechar");
      close.style.border = "0";
      close.style.background = "transparent";
      close.style.cursor = "pointer";
      close.style.fontSize = "18px";
      close.style.lineHeight = "1";
      close.style.padding = "4px 6px";
      close.style.borderRadius = "8px";

      header.appendChild(titleWrap);
      header.appendChild(close);

      var body = document.createElement("div");
      body.id = "crmModalBody";
      body.className = "crmModalBody";
      body.style.padding = "12px 16px 16px 16px";

      modal.appendChild(header);
      modal.appendChild(body);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      crmModalOverlay = overlay;
      crmModalTitle = title;
      crmModalSub = sub;
      crmModalBody = body;
      crmModalClose = close;

      crmModalClose.addEventListener("click", crmCloseModal);
      crmModalOverlay.addEventListener("click", function(e){
        if (e.target === crmModalOverlay) crmCloseModal();
      });
    }

    crmEnsureModal();


    function crmOpenModal(title, sub, bodyEl){
      if (!crmModalOverlay || !crmModalTitle || !crmModalSub || !crmModalBody) crmEnsureModal();
      crmModalTitle.textContent = title || "—";
      crmModalSub.textContent = sub || "";
      crmModalBody.innerHTML = "";
      if (bodyEl) crmModalBody.appendChild(bodyEl);
      crmModalOverlay.style.display = "flex";
      crmModalOverlay.setAttribute("aria-hidden", "false");
    }
    function crmCloseModal(){
      crmModalOverlay.style.display = "none";
      crmModalOverlay.setAttribute("aria-hidden", "true");
      crmModalBody.innerHTML = "";
    }
    if (crmModalClose) crmModalClose.addEventListener("click", crmCloseModal);
    if (crmModalOverlay) crmModalOverlay.addEventListener("click", function(e){
      if (e.target === crmModalOverlay) crmCloseModal();
    });

    function crmId(prefix){
      return (prefix || "id") + "_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
    }

    function crmActivePipeline(){
      if (!crmState) return null;
      return (crmState.pipelines || []).find(function(p){ return p.id === crmState.activePipelineId; }) || (crmState.pipelines || [])[0] || null;
    }

    function crmStageIconOptions(){
      return [
        { icon:"ph-flag-checkered", label:"Novo lead" },
        { icon:"ph-user-circle-plus", label:"Contato" },
        { icon:"ph-chat-circle-dots", label:"Conversa" },
        { icon:"ph-whatsapp-logo", label:"WhatsApp" },
        { icon:"ph-phone-call", label:"Ligação" },
        { icon:"ph-calendar-check", label:"Reunião" },
        { icon:"ph-file-text", label:"Proposta" },
        { icon:"ph-handshake", label:"Fechou" },
        { icon:"ph-currency-circle-dollar", label:"Venda" },
        { icon:"ph-chart-line-up", label:"Avanço" },
        { icon:"ph-target", label:"Prioridade" },
        { icon:"ph-rocket-launch", label:"Acelerar" },
        { icon:"ph-star", label:"Quente" },
        { icon:"ph-trophy", label:"Ganho" },
        { icon:"ph-check-circle", label:"Concluído" },
        { icon:"ph-heart", label:"Relacionamento" },
        { icon:"ph-lightbulb", label:"Ideia" },
        { icon:"ph-buildings", label:"Empresa" },
        { icon:"ph-storefront", label:"Loja" },
        { icon:"ph-briefcase", label:"Negócio" },
        { icon:"ph-envelope-simple", label:"E-mail" },
        { icon:"ph-megaphone", label:"Campanha" },
        { icon:"ph-magic-wand", label:"Automação" },
        { icon:"ph-funnel", label:"Funil" }
      ];
    }

    function crmStageIconName(stageOrIdx, maybeIdx){
      var options = crmStageIconOptions();
      var valid = options.map(function(x){ return x.icon; });
      var stage = (stageOrIdx && typeof stageOrIdx === "object") ? stageOrIdx : null;
      var idx = stage ? Number(maybeIdx || 0) : Number(stageOrIdx || 0);
      if (!isFinite(idx) || idx < 0) idx = 0;
      var chosen = stage ? String(stage.icon || stage.iconClass || stage.stageIcon || "") : "";
      if (chosen && valid.indexOf(chosen) !== -1) return chosen;
      var fallbackCount = Math.min(options.length, 8);
      return options[idx % fallbackCount].icon;
    }

    function crmOpenStageIconPicker(pipelineId, stageId){
      var pipeline = crmPipelineById(pipelineId) || crmActivePipeline();
      var stage = crmStageById(pipeline, stageId);
      if (!pipeline || !stage) {
        toast("warn", "Ícone da etapa", "Não encontrei esta etapa do funil.");
        return;
      }

      var currentIcon = crmStageIconName(stage, (pipeline.stageOrder || []).indexOf(stageId));
      var wrap = document.createElement("div");
      wrap.className = "crmIconPickerPanel";
      wrap.innerHTML =
        "<div class='crmIconPickerHero'>" +
          "<div class='crmIconPickerHeroIcon'><i class='ph " + escapeHtml(currentIcon) + "'></i></div>" +
          "<div><b>Escolha o ícone desta coluna</b><span>O ícone ajuda a identificar rapidamente cada etapa do funil. A mudança fica salva somente nesta coluna.</span></div>" +
        "</div>" +
        "<div class='crmIconPickerGrid'></div>" +
        "<div class='crmIconPickerFooter'>" +
          "<button class='btn btnGhost crmIconReset' type='button'><i class='ph ph-arrow-counter-clockwise'></i> Usar padrão</button>" +
          "<button class='btn crmIconCancel' type='button'>Cancelar</button>" +
        "</div>";

      var grid = wrap.querySelector(".crmIconPickerGrid");
      crmStageIconOptions().forEach(function(opt){
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "crmIconOption" + (opt.icon === currentIcon ? " active" : "");
        btn.innerHTML = "<i class='ph " + escapeHtml(opt.icon) + "'></i><span>" + escapeHtml(opt.label) + "</span>";
        btn.addEventListener("click", function(){
          stage.icon = opt.icon;
          delete stage.iconClass;
          delete stage.stageIcon;
          crmRenderBoard();
          crmQueueSave();
          crmCloseModal();
          toast("ok", "Ícone da etapa", "Ícone atualizado.");
        });
        grid.appendChild(btn);
      });

      wrap.querySelector(".crmIconReset").addEventListener("click", function(){
        delete stage.icon;
        delete stage.iconClass;
        delete stage.stageIcon;
        crmRenderBoard();
        crmQueueSave();
        crmCloseModal();
        toast("ok", "Ícone da etapa", "Ícone padrão restaurado.");
      });
      wrap.querySelector(".crmIconCancel").addEventListener("click", crmCloseModal);

      crmOpenModal("Trocar ícone da coluna", (pipeline.name || "Funil") + " → " + (stage.name || "Etapa"), wrap);
    }

    function crmRenderSummary(){
      var p = crmActivePipeline();
      var pipes = (crmState && Array.isArray(crmState.pipelines)) ? crmState.pipelines : [];
      var stageCount = p && Array.isArray(p.stageOrder) ? p.stageOrder.length : 0;
      var placedCount = 0;
      if (p && p.stageOrder) {
        (p.stageOrder || []).forEach(function(sid){
          var st = p.stages && p.stages[sid];
          placedCount += (st && Array.isArray(st.leadIds)) ? st.leadIds.length : 0;
        });
      }
      var totalLeads = Array.isArray(crmLeads) ? crmLeads.length : 0;
      var elName = document.getElementById("crmActivePipelineName");
      var elHint = document.getElementById("crmActivePipelineHint");
      var elStages = document.getElementById("crmStatStages");
      var elPlaced = document.getElementById("crmStatPlaced");
      var elTotal = document.getElementById("crmStatTotal");
      if (elName) elName.textContent = p && p.name ? p.name : "Nenhum funil ativo";
      if (elHint) elHint.textContent = stageCount + " etapa(s) · " + placedCount + " lead(s) neste funil · " + pipes.length + " funil(is) cadastrado(s)";
      if (elStages) elStages.textContent = stageCount;
      if (elPlaced) elPlaced.textContent = placedCount;
      if (elTotal) elTotal.textContent = totalLeads;
    }

    function crmAllPlacedLeadIds(pipeline){
      var placed = Object.create(null);
      (pipeline.stageOrder || []).forEach(function(sid){
        var st = pipeline.stages && pipeline.stages[sid];
        (st && st.leadIds || []).forEach(function(lid){ placed[lid] = true; });
      });
      return placed;
    }

    function crmPipelineById(pipelineId){
      var id = String(pipelineId || "");
      return ((crmState && crmState.pipelines) || []).find(function(p){ return p && String(p.id) === id; }) || null;
    }

    function crmStageById(pipeline, stageId){
      if (!pipeline || !pipeline.stages) return null;
      return pipeline.stages[String(stageId || "")] || null;
    }

    function crmNormalizeHexColor(value){
      value = String(value || "").trim();
      if (!value) return "";
      if (value.charAt(0) !== "#") value = "#" + value;
      if (/^#[0-9a-fA-F]{3}$/.test(value)) {
        value = "#" + value.charAt(1) + value.charAt(1) + value.charAt(2) + value.charAt(2) + value.charAt(3) + value.charAt(3);
      }
      if (!/^#[0-9a-fA-F]{6}$/.test(value)) return "";
      return value.toUpperCase();
    }

    function crmHexToRgb(hex){
      hex = crmNormalizeHexColor(hex);
      if (!hex) return null;
      var n = parseInt(hex.slice(1), 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }

    function crmRgba(hex, alpha){
      var rgb = crmHexToRgb(hex) || { r:37, g:99, b:235 };
      return "rgba(" + rgb.r + "," + rgb.g + "," + rgb.b + "," + alpha + ")";
    }

    function crmStageColorOptions(){
      return [
        { color:"#2563EB", label:"Azul" },
        { color:"#16A34A", label:"Verde" },
        { color:"#F59E0B", label:"Amarelo" },
        { color:"#7C3AED", label:"Roxo" },
        { color:"#DC2626", label:"Vermelho" },
        { color:"#0891B2", label:"Ciano" },
        { color:"#DB2777", label:"Rosa" },
        { color:"#475569", label:"Cinza" },
        { color:"#EA4335", label:"Google vermelho" },
        { color:"#FBBC05", label:"Google amarelo" },
        { color:"#34A853", label:"Google verde" },
        { color:"#4285F4", label:"Google azul" }
      ];
    }

    function crmApplyStageColor(col, stage){
      var color = crmNormalizeHexColor(stage && (stage.color || stage.stageColor || stage.colorHex));
      if (!col || !color) return;
      col.classList.add("crmStageCustom");
      col.style.setProperty("--crm-stage-color", color);
      col.style.setProperty("--crm-stage-soft", crmRgba(color, ".45"));
      col.style.setProperty("--crm-stage-bg", crmRgba(color, ".10"));
      col.style.setProperty("--crm-stage-border", crmRgba(color, ".24"));
    }

    function crmOpenStageColorPicker(pipelineId, stageId){
      var pipeline = crmPipelineById(pipelineId) || crmActivePipeline();
      var stage = crmStageById(pipeline, stageId);
      if (!pipeline || !stage) {
        toast("warn", "Cor da etapa", "Não encontrei esta etapa do funil.");
        return;
      }
      var currentColor = crmNormalizeHexColor(stage.color || stage.stageColor || stage.colorHex) || "#2563EB";
      var wrap = document.createElement("div");
      wrap.className = "crmColorPickerPanel";
      wrap.innerHTML =
        "<div class='crmColorPickerHero' style='--preview-color:" + escapeHtml(currentColor) + "'>" +
          "<div class='crmColorPreview'></div>" +
          "<div><b>Escolha a cor desta etapa</b><span>A cor muda a faixa superior da coluna e o ícone da etapa. Isso ajuda a separar visualmente cada fase do funil.</span></div>" +
        "</div>" +
        "<div class='crmColorGrid'></div>" +
        "<div class='crmColorCustom'><label>Cor personalizada <input id='crmStageCustomColor' type='color' value='" + escapeHtml(currentColor) + "'></label><button class='btn btnPrimary crmColorApplyCustom' type='button'><i class='ph ph-palette'></i> Aplicar cor</button></div>" +
        "<div class='crmColorPickerFooter'>" +
          "<button class='btn btnGhost crmColorReset' type='button'><i class='ph ph-arrow-counter-clockwise'></i> Usar cor padrão</button>" +
          "<button class='btn crmColorCancel' type='button'>Cancelar</button>" +
        "</div>";

      var preview = wrap.querySelector(".crmColorPickerHero");
      var input = wrap.querySelector("#crmStageCustomColor");
      var grid = wrap.querySelector(".crmColorGrid");
      function applyColor(color){
        color = crmNormalizeHexColor(color);
        if (!color) return;
        stage.color = color;
        delete stage.stageColor;
        delete stage.colorHex;
        crmRenderBoard();
        crmRenderSummary();
        crmQueueSave();
        crmCloseModal();
        toast("ok", "Cor da etapa", "Cor atualizada.");
      }
      crmStageColorOptions().forEach(function(opt){
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "crmColorOption" + (crmNormalizeHexColor(opt.color) === currentColor ? " active" : "");
        btn.style.setProperty("--swatch", opt.color);
        btn.innerHTML = "<span class='crmColorSwatch'></span><span>" + escapeHtml(opt.label) + "</span>";
        btn.addEventListener("click", function(){ applyColor(opt.color); });
        grid.appendChild(btn);
      });
      if (input) input.addEventListener("input", function(){ if (preview) preview.style.setProperty("--preview-color", input.value); });
      wrap.querySelector(".crmColorApplyCustom").addEventListener("click", function(){ applyColor(input ? input.value : currentColor); });
      wrap.querySelector(".crmColorReset").addEventListener("click", function(){
        delete stage.color;
        delete stage.stageColor;
        delete stage.colorHex;
        crmRenderBoard();
        crmRenderSummary();
        crmQueueSave();
        crmCloseModal();
        toast("ok", "Cor da etapa", "Cor padrão restaurada.");
      });
      wrap.querySelector(".crmColorCancel").addEventListener("click", crmCloseModal);
      crmOpenModal("Trocar cor da coluna", (pipeline.name || "Funil") + " → " + (stage.name || "Etapa"), wrap);
    }

    function crmLeadIsPlacedInPipeline(pipeline, leadId){
      if (!pipeline || !leadId) return false;
      return (pipeline.stageOrder || []).some(function(sid){
        var st = pipeline.stages && pipeline.stages[sid];
        return !!(st && (st.leadIds || []).indexOf(leadId) !== -1);
      });
    }

    function crmSelectedLeadIdList(){
      var p = crmActivePipeline();
      if (!p) return [];
      var ids = Object.keys(crmSelectedLeadIds || {});
      return ids.filter(function(id){ return crmSelectedLeadIds[id] && crmLeadIsPlacedInPipeline(p, id); });
    }

    function crmPlacedLeadIdList(pipeline){
      var ids = [];
      if (!pipeline) return ids;
      (pipeline.stageOrder || []).forEach(function(sid){
        var st = pipeline.stages && pipeline.stages[sid];
        (st && st.leadIds || []).forEach(function(leadId){ if (ids.indexOf(leadId) === -1) ids.push(leadId); });
      });
      return ids;
    }

    function crmCleanupSelectedLeads(){
      var valid = crmSelectedLeadIdList();
      var next = Object.create(null);
      valid.forEach(function(id){ next[id] = true; });
      crmSelectedLeadIds = next;
      return valid;
    }

    function crmRenderBulkToolbar(){
      crmBulkToolbar = crmBulkToolbar || document.getElementById("crmBulkToolbar");
      var panel = document.getElementById("panelCrm");
      if (panel) panel.classList.toggle("crmBulkActive", !!crmBulkMode);
      if (crmBtnBulkMode) {
        crmBtnBulkMode.classList.toggle("crmActionMain", !!crmBulkMode);
        var label = crmBtnBulkMode.querySelector("b");
        var small = crmBtnBulkMode.querySelector("small");
        if (label) label.textContent = crmBulkMode ? "Seleção ativa" : "Selecionar leads";
        if (small) small.textContent = crmBulkMode ? "Arraste os selecionados" : "Arrastar ou remover em lote";
      }
      if (!crmBulkToolbar) return;
      if (!crmBulkMode) {
        crmBulkToolbar.hidden = true;
        crmBulkToolbar.innerHTML = "";
        return;
      }
      var p = crmActivePipeline();
      var selected = crmCleanupSelectedLeads();
      var totalPlaced = crmPlacedLeadIdList(p).length;
      crmBulkToolbar.hidden = false;
      crmBulkToolbar.innerHTML =
        "<div class='crmBulkInfo'>" +
          "<span class='crmBulkInfoIcon'><i class='ph ph-check-square-offset'></i></span>" +
          "<div><b>" + selected.length + " lead(s) selecionado(s)</b><span>Arraste um dos selecionados para outra coluna para mover todos juntos.</span></div>" +
        "</div>" +
        "<div class='crmBulkActions'>" +
          "<button class='btn crmBulkSelectAll' type='button'><i class='ph ph-checks'></i> Selecionar todos (" + totalPlaced + ")</button>" +
          "<button class='btn crmBulkClear' type='button'><i class='ph ph-x'></i> Limpar</button>" +
          "<button class='btn btnGhost crmBulkRemove' type='button'><i class='ph ph-trash'></i> Remover do funil</button>" +
          "<button class='btn crmBulkDone' type='button'>Concluir</button>" +
        "</div>";
      crmBulkToolbar.querySelector(".crmBulkSelectAll").addEventListener("click", function(){
        crmSelectedLeadIds = Object.create(null);
        crmPlacedLeadIdList(crmActivePipeline()).forEach(function(id){ crmSelectedLeadIds[id] = true; });
        crmRenderBoard();
        crmRenderBulkToolbar();
      });
      crmBulkToolbar.querySelector(".crmBulkClear").addEventListener("click", function(){
        crmSelectedLeadIds = Object.create(null);
        crmRenderBoard();
        crmRenderBulkToolbar();
      });
      crmBulkToolbar.querySelector(".crmBulkRemove").addEventListener("click", async function(){
        var ids = crmSelectedLeadIdList();
        if (!ids.length) { toast("warn", "Seleção", "Selecione pelo menos um lead."); return; }
        if (!(await crmConfirm("Remover " + ids.length + " lead(s) deste funil? Eles continuarão existindo na base de leads e nas conversas."))) return;
        crmRemoveLeadsFromFunnel(ids, true);
      });
      crmBulkToolbar.querySelector(".crmBulkDone").addEventListener("click", function(){ crmSetBulkMode(false); });
    }

    function crmSetBulkMode(enabled){
      crmBulkMode = !!enabled;
      if (!crmBulkMode) crmSelectedLeadIds = Object.create(null);
      crmRenderBoard();
      crmRenderBulkToolbar();
    }

    function crmToggleLeadSelection(leadId, checked){
      if (!leadId) return;
      if (checked) crmSelectedLeadIds[leadId] = true;
      else delete crmSelectedLeadIds[leadId];
      crmRenderBulkToolbar();
      var card = crmBoard && crmBoard.querySelector(".crmCard[data-lead-id='" + String(leadId).replace(/'/g,"\\'") + "']");
      if (card) card.classList.toggle("crmCardSelected", !!crmSelectedLeadIds[leadId]);
    }

    function crmWebhookDisplayName(w){
      return String((w && (w.displayName || w.name || w.urlPreview || w.url)) || "Webhook").trim() || "Webhook";
    }

    function crmWebhookTargetText(w){
      var target = w && w.crmTarget && w.crmTarget.enabled !== false ? w.crmTarget : null;
      if (!target) return "Este webhook ainda não está vinculado a nenhum funil.";
      var p = crmPipelineById(target.pipelineId);
      var st = crmStageById(p, target.stageId);
      if (!p || !st) return "Este webhook tem um vínculo antigo, mas o funil ou a etapa não existe mais.";
      return "Vínculo atual: " + p.name + " → " + st.name + ".";
    }

    function crmFillStageSelect(stageSelect, pipelineId, selectedStageId){
      if (!stageSelect) return;
      stageSelect.innerHTML = "";
      var p = crmPipelineById(pipelineId) || crmActivePipeline();
      if (!p) return;
      (p.stageOrder || []).forEach(function(sid){
        var st = p.stages && p.stages[sid];
        if (!st) return;
        var opt = document.createElement("option");
        opt.value = sid;
        opt.textContent = st.name || "Etapa";
        stageSelect.appendChild(opt);
      });
      if (selectedStageId && p.stages && p.stages[selectedStageId]) stageSelect.value = selectedStageId;
      else if (stageSelect.options.length) stageSelect.value = stageSelect.options[0].value;
    }

    async function crmOpenWebhookLink(){
      if (!crmState) {
        try { await crmLoad(); } catch(e) {}
      }
      try { await loadWebhooks(); webhooksLoadedOnce = true; } catch(e) {}

      var wrap = document.createElement("div");
      wrap.className = "crmWebhookFlow";

      var hero = document.createElement("div");
      hero.className = "crmWebhookHero";
      hero.innerHTML =
        "<div class='crmWebhookHeroIcon'><i class='ph ph-plugs-connected'></i></div>" +
        "<div>" +
          "<div class='crmWebhookHeroTitle'>Entrada automática direto no funil</div>" +
          "<div class='crmWebhookHeroText'>Escolha um webhook já criado e defina em qual funil e etapa os próximos leads devem entrar. O cadastro continua funcionando normalmente nos leads, conversas, insights e mensagens automáticas.</div>" +
        "</div>";
      wrap.appendChild(hero);

      if (!Array.isArray(webhookItems) || !webhookItems.length) {
        var empty = document.createElement("div");
        empty.className = "crmWebhookEmpty";
        empty.innerHTML = "<b>Nenhum webhook criado ainda.</b><br>Crie primeiro um link na área de Webhooks. Depois volte aqui para vincular esse link a um funil.";
        wrap.appendChild(empty);
        var emptyActions = document.createElement("div");
        emptyActions.className = "crmWebhookLinkActions";
        emptyActions.innerHTML = "<button class='btn' type='button'>Fechar</button><button class='btn btnPrimary' type='button'><i class='ph ph-webhooks-logo'></i> Abrir Webhooks</button>";
        wrap.appendChild(emptyActions);
        emptyActions.children[0].addEventListener("click", crmCloseModal);
        emptyActions.children[1].addEventListener("click", function(){
          crmCloseModal();
          if (ovTemplate) ovTemplate.classList.add("open");
          loadWebhooks().catch(function(){});
        });
        crmOpenModal("Vincular webhook", "Conecte uma origem automática ao funil de vendas.", wrap);
        return;
      }

      var steps = document.createElement("div");
      steps.className = "crmWebhookSteps";
      steps.innerHTML =
        "<div class='crmWebhookStepCard'><i class='ph ph-webhooks-logo'></i><div><b>1. Escolha a origem</b><span>Selecione o webhook que já recebe os cadastros.</span></div></div>" +
        "<div class='crmWebhookStepCard'><i class='ph ph-kanban'></i><div><b>2. Defina o funil</b><span>Escolha o pipeline que deve receber esses leads.</span></div></div>" +
        "<div class='crmWebhookStepCard'><i class='ph ph-flag-checkered'></i><div><b>3. Escolha a etapa</b><span>Todo novo lead cairá automaticamente nesse ponto.</span></div></div>";
      wrap.appendChild(steps);

      var currentPipeline = crmActivePipeline();
      var grid = document.createElement("div");
      grid.className = "crmWebhookSelectorGrid";
      grid.innerHTML =
        "<div class='crmWebhookField'><label for='crmWebhookSelect'><i class='ph ph-webhooks-logo'></i> Webhook existente</label><select id='crmWebhookSelect'></select></div>" +
        "<div class='crmWebhookField'><label for='crmWebhookPipeline'><i class='ph ph-kanban'></i> Funil de destino</label><select id='crmWebhookPipeline'></select></div>" +
        "<div class='crmWebhookField'><label for='crmWebhookStage'><i class='ph ph-signpost'></i> Etapa inicial</label><select id='crmWebhookStage'></select></div>";
      wrap.appendChild(grid);

      var webhookSelect = grid.querySelector("#crmWebhookSelect");
      var pipelineSelect = grid.querySelector("#crmWebhookPipeline");
      var stageSelect = grid.querySelector("#crmWebhookStage");

      webhookItems.forEach(function(w){
        var opt = document.createElement("option");
        opt.value = w.id;
        opt.textContent = crmWebhookDisplayName(w) + (w.crmTarget && w.crmTarget.enabled !== false ? " · já vinculado" : "");
        webhookSelect.appendChild(opt);
      });

      ((crmState && crmState.pipelines) || []).forEach(function(p){
        var opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name || "Funil";
        pipelineSelect.appendChild(opt);
      });
      if (currentPipeline) pipelineSelect.value = currentPipeline.id;

      var info = document.createElement("div");
      info.className = "crmWebhookStatusCard";
      wrap.appendChild(info);

      function selectedCrmWebhook(){
        var id = webhookSelect.value;
        return (webhookItems || []).find(function(w){ return String(w.id) === String(id); }) || null;
      }

      function selectedPipeline(){ return crmPipelineById(pipelineSelect.value) || crmActivePipeline(); }
      function selectedStage(){
        var p = selectedPipeline();
        return crmStageById(p, stageSelect.value);
      }

      function refreshWebhookBindingUi(){
        var w = selectedCrmWebhook();
        var target = w && w.crmTarget && w.crmTarget.enabled !== false ? w.crmTarget : null;
        if (target && crmPipelineById(target.pipelineId)) {
          pipelineSelect.value = target.pipelineId;
        } else if (currentPipeline) {
          pipelineSelect.value = currentPipeline.id;
        }
        crmFillStageSelect(stageSelect, pipelineSelect.value, target && target.stageId);
        var name = crmWebhookDisplayName(w);
        var p = selectedPipeline();
        var st = selectedStage();
        var linked = !!target;
        var statusClass = linked ? "crmWebhookStatusBadge" : "crmWebhookStatusBadge is-unlinked";
        var statusText = linked ? "Já vinculado" : "Sem vínculo ativo";
        info.innerHTML =
          "<div class='crmWebhookStatusTop'>" +
            "<div class='crmWebhookStatusTitle'><i class='ph ph-info'></i> Como vai funcionar</div>" +
            "<span class='" + statusClass + "'><i class='ph " + (linked ? "ph-check-circle" : "ph-warning-circle") + "'></i> " + statusText + "</span>" +
          "</div>" +
          "<div>Todo novo lead que chegar por esse webhook continuará entrando normalmente nos leads, conversas, insights e mensagens automáticas. Além disso, será colocado automaticamente no funil abaixo.</div>" +
          "<div class='crmWebhookFlowLine'>" +
            "<span class='crmWebhookFlowPill'><i class='ph ph-webhooks-logo'></i> " + escapeHtml(name) + "</span>" +
            "<span class='crmWebhookFlowArrow'>→</span>" +
            "<span class='crmWebhookFlowPill'><i class='ph ph-kanban'></i> " + escapeHtml((p && p.name) || "Funil") + "</span>" +
            "<span class='crmWebhookFlowArrow'>→</span>" +
            "<span class='crmWebhookFlowPill'><i class='ph ph-flag-checkered'></i> " + escapeHtml((st && st.name) || "Etapa") + "</span>" +
          "</div>";
      }

      webhookSelect.addEventListener("change", refreshWebhookBindingUi);
      pipelineSelect.addEventListener("change", function(){ crmFillStageSelect(stageSelect, pipelineSelect.value, ""); refreshWebhookBindingUi(); });
      stageSelect.addEventListener("change", refreshWebhookBindingUi);
      refreshWebhookBindingUi();

      var actions = document.createElement("div");
      actions.className = "crmWebhookLinkActions";
      actions.innerHTML =
        "<button class='btn' type='button'>Cancelar</button>" +
        "<button class='btn btnGhost' type='button'><i class='ph ph-link-break'></i> Desvincular</button>" +
        "<button class='btn btnPrimary' type='button'><i class='ph ph-plugs-connected'></i> Salvar vínculo</button>";
      wrap.appendChild(actions);

      actions.children[0].addEventListener("click", crmCloseModal);
      actions.children[1].addEventListener("click", async function(){
        var w = selectedCrmWebhook();
        if (!w) return;
        try {
          await crmFetchJson(API_BASE + "/webhooks/" + encodeURIComponent(w.id), {
            method:"PUT",
            body: JSON.stringify({ crmTarget: null })
          });
          await loadWebhooks();
          toast("ok", "Webhook", "Vínculo removido do funil.");
          crmCloseModal();
        } catch(e) {
          toast("err", "Webhook", "Falha ao desvincular: " + e.message);
        }
      });
      actions.children[2].addEventListener("click", async function(){
        var w = selectedCrmWebhook();
        var pipelineId = pipelineSelect.value;
        var stageId = stageSelect.value;
        if (!w || !pipelineId || !stageId) {
          toast("warn", "Webhook", "Selecione webhook, funil e etapa.");
          return;
        }
        try {
          await crmFetchJson(API_BASE + "/webhooks/" + encodeURIComponent(w.id), {
            method:"PUT",
            body: JSON.stringify({
              crmTarget: {
                enabled: true,
                pipelineId: pipelineId,
                stageId: stageId
              }
            })
          });
          await loadWebhooks();
          toast("ok", "Webhook vinculado", "Novos leads desse webhook entrarão automaticamente no funil.");
          crmCloseModal();
        } catch(e) {
          toast("err", "Webhook", "Falha ao salvar vínculo: " + e.message);
        }
      });

      crmOpenModal("Vincular webhook ao funil", "Configure a entrada automática de leads no pipeline comercial.", wrap);
    }

    async function crmFetchJson(url, opts){
      var options = Object.assign({}, opts || {});
      options.headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
      return window.zapeApi.json(url, options);
    }

    
    function crmDigitsOnly(s){ return String(s||"").replace(/\D+/g,""); }

    function crmValidateManualLead(payload){
      var nome = String(payload.nome||"").trim();
      var email = String(payload.email||"").trim();
      var wa = crmDigitsOnly(payload.whatsapp||"");
      if (!nome) return { ok:false, error:"Nome é obrigatório." };
      if (!email && wa.length < 10) return { ok:false, error:"Informe e-mail ou WhatsApp válido." };
      return { ok:true };
    }

    async function crmCreateManualLeadApi(payload){
      // cria lead no backend e devolve o objeto lead
      var v = crmValidateManualLead(payload);
      if (!v.ok) throw new Error(v.error);
      var res = await crmFetchJson(CRM_API_PREFIX + "/leads/manual", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(payload || {})
      });
      if (!res || !res.ok) throw new Error((res && res.error) ? res.error : "Falha ao criar lead.");
      return res.lead;
    }

    function crmGetDefaultStageIdForCurrentFunnel(){
      var f = crmActivePipeline();
      if (!f) return null;
      var stageIds = Array.isArray(f.stageIds) ? f.stageIds : [];
      if (stageIds.length) return stageIds[0];
      // fallback: se tiver stages em f.stages (format antigo)
      if (Array.isArray(f.stages) && f.stages.length) return f.stages[0].id;
      return null;
    }

    async function crmCreateLeadAndPlace(payload){
      // 1) cria lead
      var lead = await crmCreateManualLeadApi(payload);

      // 2) injeta no cache local imediatamente
      if (!crmLeadById) crmLeadById = Object.create(null);
      crmLeadById[lead.id] = lead;
      if (!Array.isArray(crmLeads)) crmLeads = [];
      crmLeads.unshift(lead);

      // 3) coloca no funil/etapa atual (primeira etapa)
      var stageId = crmGetDefaultStageIdForCurrentFunnel();
      if (!stageId) throw new Error("Funil sem etapas. Crie uma etapa primeiro.");

      // garante que o lead entra no state mesmo se crmMoveLeadToStage esperar lead já existente
      crmMoveLeadToStage(lead.id, stageId);

      // re-render e salva (crmMoveLeadToStage já deve salvar; mas garantimos)
      crmRender();
      crmQueueSave();

      return lead;
    }

function crmExtractLeads(payload){
      if (!payload) return [];
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload.items)) return payload.items;
      if (Array.isArray(payload.leads)) return payload.leads;
      if (Array.isArray(payload.data)) return payload.data;
      for (var k in payload){
        if (payload && Object.prototype.hasOwnProperty.call(payload,k) && Array.isArray(payload[k])) return payload[k];
      }
      return [];
    }


    async function crmLoad(){
      var res = await Promise.all([
        crmFetchJson(CRM_API_PREFIX + "/crm"),
        fetchAllLeadPages(new URLSearchParams("dedupe=1&sortBy=createdAt&sortDir=desc"))
      ]);
      crmState = res[0].state;
      crmLeads = Array.isArray(res[1]) ? res[1] : [];
      crmLeadById = Object.create(null);
      crmLeads.forEach(function(l){ if (l && l.id) crmLeadById[l.id] = l; });
    }

    function crmQueueSave(){
      if (!crmState) return;
      if (crmSaveTimer) clearTimeout(crmSaveTimer);
      crmSaveTimer = setTimeout(crmSaveNow, 150);
    }

    async function crmSaveNow(){
      if (!crmState) return;
      if (crmSaving) return;
      crmSaving = true;
      try {
        await crmFetchJson(CRM_API_PREFIX + "/crm", {
          method: "PUT",
          body: JSON.stringify({ state: crmState })
        });
      } catch (e) {
        console.error(e);
        toast("err", "Funil de Vendas", "Erro ao salvar CRM: " + e.message);
      } finally {
        crmSaving = false;
      }
    }

    function crmSetActivePipeline(pid){
      crmState.activePipelineId = pid;
      crmSelectedLeadIds = Object.create(null);
      crmRender();
      crmQueueSave();
    }

    async function crmPromptRename(label, current){
      var v = await uiPrompt("Renomear " + label, "Digite o novo nome e salve a alteração.", current || "", { okText: "Renomear" });
      if (v == null) return null;
      v = String(v).trim();
      if (!v) return null;
      return v;
    }

    async function crmConfirm(msg){
      return await uiConfirm("Confirmar alteração no funil", msg, { tone: "danger", okText: "Confirmar", icon: "ph-warning-circle" });
    }

    function crmRenderTabs(){
      crmPipelinesBar.innerHTML = "";
      var pipes = crmState.pipelines || [];
      pipes.forEach(function(p){
        var tab = document.createElement("button");
        tab.type = "button";
        tab.className = "crmTab" + (p.id === crmState.activePipelineId ? " active" : "");
        var placedCount = 0;
        (p.stageOrder || []).forEach(function(sid){
          var st = p.stages && p.stages[sid];
          placedCount += (st && st.leadIds ? st.leadIds.length : 0);
        });
        tab.innerHTML = "<span class='crmTabIcon'><i class='ph ph-funnel'></i></span>" +
                        "<span class='crmTabName'>" + escapeHtml(p.name || "Funil") + "</span>" +
                        "<span class='pill'>" + placedCount + "</span>" +
                        "<span class='funnelMenuDots' style='margin-left:auto;display:inline-flex;align-items:center;'>" + iconMarkup("ellipsis", "Opções", "sm") + "</span>"; 
        tab.addEventListener("click", function(){
          // clique no tab ativa; clique no ⋯ abre opções
          crmSetActivePipeline(p.id);
        });
        tab.addEventListener("contextmenu", function(e){
          e.preventDefault();
          crmPipelineMenu(p);
        });
        tab.addEventListener("dblclick", async function(e){
          e.preventDefault();
          var nn = await crmPromptRename("funil", p.name);
          if (!nn) return;
          p.name = nn;
          crmRender();
          crmQueueSave();
        });
        tab.addEventListener("mouseup", function(e){
          // se clicou no ⋯, abre menu
          var rect = tab.getBoundingClientRect();
          if (e.clientX > rect.right - 38) {
            crmPipelineMenu(p);
          }
        });
        crmPipelinesBar.appendChild(tab);
      });
    }

    async function crmPipelineMenu(p){
      var act = await uiChoice("Opções do funil", "Escolha o que deseja fazer com este funil.", [
        { value: "rename", label: "Renomear funil" },
        { value: "delete", label: "Excluir funil" }
      ], { icon: "ph-dots-three-circle" });
      if (!act) return;
      if (act === "rename") {
        var nn = await crmPromptRename("funil", p.name);
        if (!nn) return;
        p.name = nn;
        crmRender();
        crmQueueSave();
        return;
      }
      if (act === "delete") {
        if (!(await crmConfirm("Excluir o funil '" + p.name + "'? Isso remove as etapas e posições. Os leads continuam existindo."))) return;
        crmState.pipelines = (crmState.pipelines || []).filter(function(x){ return x.id !== p.id; });
        if (!crmState.pipelines.length) {
          // cria um novo default bem simples
          var np = {
            id: crmId("pipe"),
            name: "Funil Principal",
            createdAt: new Date().toISOString(),
            stageOrder: [],
            stages: {}
          };
          crmState.pipelines = [np];
          crmState.activePipelineId = np.id;
        } else if (crmState.activePipelineId === p.id) {
          crmState.activePipelineId = crmState.pipelines[0].id;
        }
        crmRender();
        crmQueueSave();
      }
    }


    function crmStageMessages(stage){
      if (!stage || typeof stage !== "object") return [];
      var list = null;
      if (Array.isArray(stage.autoMessages)) list = stage.autoMessages;
      else if (Array.isArray(stage.crmAutoMessages)) list = stage.crmAutoMessages;
      else if (Array.isArray(stage.crmMessageTexts)) list = stage.crmMessageTexts;
      else if (Array.isArray(stage.messageTexts)) list = stage.messageTexts;
      var fallback = stage.autoMessageText || stage.crmAutoMessageText || stage.crmMessageText || stage.messageText || "";
      if (!list && fallback) list = [fallback];
      return (list || []).map(function(value){ return String(value || "").trim(); }).filter(Boolean).slice(0, 10);
    }

    function crmStageMessageText(stage){
      var list = crmStageMessages(stage);
      return list.length ? list[0] : "";
    }

    function crmStageMessageCount(stage){
      return crmStageMessages(stage).length;
    }

    function crmInsertAtCursor(textarea, value){
      if (!textarea) return;
      var start = typeof textarea.selectionStart === "number" ? textarea.selectionStart : textarea.value.length;
      var end = typeof textarea.selectionEnd === "number" ? textarea.selectionEnd : textarea.value.length;
      var before = textarea.value.slice(0, start);
      var after = textarea.value.slice(end);
      textarea.value = before + value + after;
      textarea.focus();
      var pos = start + value.length;
      try { textarea.setSelectionRange(pos, pos); } catch(e) {}
    }

    function crmOpenStageMessage(pipelineId, stageId){
      var pipeline = crmPipelineById(pipelineId) || crmActivePipeline();
      var stage = crmStageById(pipeline, stageId);
      if (!pipeline || !stage) {
        toast("warn", "Mensagem da etapa", "Não encontrei esta etapa do funil.");
        return;
      }

      var wrap = document.createElement("div");
      wrap.className = "crmStageMessagePanel";
      var existingMessages = crmStageMessages(stage);
      var existingLabel = existingMessages.length ? (existingMessages.length + " mensagem(ns) ativa(s)") : "Nenhuma mensagem ativa";
      wrap.innerHTML =
        "<div class='crmStageMessageHero'>" +
          "<div class='crmStageMessageHeroIcon'><i class='ph ph-paper-plane-tilt'></i></div>" +
          "<div><b>Sequência automática desta etapa</b>" +
          "<span>Quando um lead entrar em <strong>" + escapeHtml(stage.name || "Etapa") + "</strong>, as mensagens abaixo serão enviadas em sequência pelo WhatsApp. Se deixar vazio, nada será disparado.</span></div>" +
          "<span class='crmStageMessageStatus'><i class='ph ph-check-circle'></i>" + escapeHtml(existingLabel) + "</span>" +
        "</div>" +
        "<div class='crmStageMessageListHead'><div><b>Mensagens programadas</b><span>Edite a mensagem existente ou adicione novas mensagens para enviar em sequência.</span></div><button class='btn btnGhost' type='button' id='crmStageMsgAdd'><i class='ph ph-plus'></i> Adicionar mensagem</button></div>" +
        "<div class='crmStageMessageList' id='crmStageMsgList'></div>" +
        "<div class='crmStageMessageTokenBlock'><div class='crmStageMessageTokenTitle'><i class='ph ph-brackets-curly'></i> Clique para inserir uma variável na mensagem selecionada</div><div class='crmStageMessageTokens' aria-label='Variáveis disponíveis'></div></div>" +
        "<div class='crmStageMessageInfo'><i class='ph ph-info'></i><div><b>Como funciona:</b> essa sequência só dispara para leads que entrarem nesta etapa depois de salvar. Leads que já estavam na coluna não recebem automaticamente.</div></div>" +
        "<div class='crmStageMessageActions'><button class='btn btnGhost' type='button' id='crmStageMsgClear'><i class='ph ph-eraser'></i> Limpar sequência</button><button class='btn' type='button' id='crmStageMsgCancel'>Cancelar</button><button class='btn btnPrimary' type='button' id='crmStageMsgSave'><i class='ph ph-floppy-disk'></i> Salvar sequência</button></div>";

      var listBox = wrap.querySelector("#crmStageMsgList");
      var activeTextarea = null;

      function refreshMessageNumbers(){
        Array.prototype.forEach.call(listBox.querySelectorAll(".crmStageMessageItem"), function(item, idx){
          var n = item.querySelector(".crmStageMessageNumber");
          if (n) n.textContent = String(idx + 1);
          var label = item.querySelector(".crmStageMessageItemTitle");
          if (label) label.textContent = "Mensagem " + (idx + 1);
        });
      }

      function addStageMessageTextarea(text){
        var item = document.createElement("div");
        item.className = "crmStageMessageItem";
        item.innerHTML =
          "<div class='crmStageMessageItemHead'>" +
            "<div class='crmStageMessageItemTitleWrap'><span class='crmStageMessageNumber'>1</span><div><b class='crmStageMessageItemTitle'>Mensagem</b><small>Será enviada nesta ordem quando o lead entrar na etapa.</small></div></div>" +
            "<button class='btnMini crmStageMessageRemove' type='button' title='Remover esta mensagem'><i class='ph ph-trash'></i></button>" +
          "</div>" +
          "<textarea class='crmStageMessageTextarea crmStageMsgItem' placeholder='Ex: Olá {{nome}}, tudo bem? Vi que você chegou na etapa " + escapeHtml(stage.name || "do funil") + ". Posso te ajudar por aqui?'></textarea>";
        var textarea = item.querySelector("textarea");
        textarea.value = text || "";
        textarea.addEventListener("focus", function(){ activeTextarea = textarea; });
        textarea.addEventListener("click", function(){ activeTextarea = textarea; });
        item.querySelector(".crmStageMessageRemove").addEventListener("click", function(){
          item.remove();
          refreshMessageNumbers();
          var remaining = listBox.querySelector("textarea");
          activeTextarea = remaining || null;
        });
        listBox.appendChild(item);
        activeTextarea = textarea;
        refreshMessageNumbers();
        return textarea;
      }

      (existingMessages.length ? existingMessages : [""]).forEach(function(m){ addStageMessageTextarea(m); });

      var addBtn = wrap.querySelector("#crmStageMsgAdd");
      if (addBtn) addBtn.addEventListener("click", function(){
        var ta = addStageMessageTextarea("");
        setTimeout(function(){ ta.focus(); }, 30);
      });

      var tokens = wrap.querySelector(".crmStageMessageTokens");
      ["{{nome}}", "{{empresa}}", "{{email}}", "{{whatsapp}}", "{{etapa}}", "{{funil}}"].forEach(function(t){
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "crmStageMessageToken";
        btn.innerHTML = "<i class='ph ph-brackets-curly'></i>" + escapeHtml(t);
        btn.addEventListener("click", function(){
          var target = activeTextarea || listBox.querySelector("textarea");
          crmInsertAtCursor(target, t);
          activeTextarea = target;
        });
        tokens.appendChild(btn);
      });
      wrap.querySelector("#crmStageMsgCancel").addEventListener("click", crmCloseModal);
      wrap.querySelector("#crmStageMsgClear").addEventListener("click", function(){
        listBox.innerHTML = "";
        var ta = addStageMessageTextarea("");
        setTimeout(function(){ ta.focus(); }, 30);
      });
      wrap.querySelector("#crmStageMsgSave").addEventListener("click", function(){
        var messages = Array.prototype.map.call(listBox.querySelectorAll(".crmStageMsgItem"), function(textarea){
          return String(textarea.value || "").trim();
        }).filter(Boolean).slice(0, 10);

        stage.autoMessages = messages;
        delete stage.autoMessageText;
        delete stage.crmAutoMessages;
        delete stage.crmAutoMessageText;
        delete stage.crmMessageTexts;
        delete stage.crmMessageText;
        delete stage.messageTexts;
        delete stage.messageText;

        crmRenderBoard();
        crmQueueSave();
        crmCloseModal();
        toast("ok", "Mensagem da etapa", messages.length ? (messages.length + " mensagem(ns) vinculada(s) à coluna.") : "Sequência removida da coluna.");
      });

      crmOpenModal("Vincular mensagem à coluna", (pipeline.name || "Funil") + " → " + (stage.name || "Etapa"), wrap);
    }

    function crmOpenLeadChat(leadId){
      var lead = crmLeadById[leadId] || null;
      if (!lead) {
        toast("warn", "Conversar", "Não encontrei este lead.");
        return;
      }
      var digits = String(lead.whatsapp_digits || lead.whatsapp_raw || "").replace(/\D+/g, "");
      if (!digits) {
        toast("warn", "Conversar", "Este lead não tem WhatsApp cadastrado.");
        return;
      }
      if (typeof openConversationFromInsight === "function") {
        crmCloseModal();
        openConversationFromInsight({
          whatsapp_digits: digits,
          nome: lead.nome || "",
          empresa: lead.empresa || "",
          email: lead.email || ""
        });
      } else {
        setActiveNav("chats");
        toast("warn", "Conversar", "Abra a conversa pelo número: " + digits);
      }
    }

    function crmRenderBoard(){
      crmBoard.innerHTML = "";
      var p = crmActivePipeline();
      if (!p) {
        crmBoard.innerHTML = "<div class='crmEmptyBoard'>Nenhum funil configurado ainda. Crie um novo funil para começar a organizar os leads.</div>";
        return;
      }

      (p.stageOrder || []).forEach(function(stageId, idx){
        var st = p.stages[stageId];
        if (!st) return;
        var col = document.createElement("div");
        col.className = "crmCol crmStageTone" + ((idx % 4) + 1);
        crmApplyStageColor(col, st);
        col.dataset.stageId = stageId;
        col.draggable = true;
        col.setAttribute("title", "Arraste a coluna para reorganizar as etapas");

        col.addEventListener("dragstart", function(e){
          if (e.target && e.target.closest && (e.target.closest(".crmCard") || e.target.closest("button") || e.target.closest("input") || e.target.closest("select") || e.target.closest("textarea"))) return;
          crmDraggedStageId = stageId;
          col.classList.add("crmStageDragging");
          try {
            e.dataTransfer.setData(CRM_STAGE_DRAG_TYPE, stageId);
            e.dataTransfer.setData("text/plain", "stage:" + stageId);
            e.dataTransfer.effectAllowed = "move";
          } catch(err) {}
        });
        col.addEventListener("dragend", function(){
          crmDraggedStageId = null;
          col.classList.remove("crmStageDragging");
          crmClearStageDropHints();
        });
        col.addEventListener("dragover", function(e){
          var fromStageId = (e.dataTransfer && e.dataTransfer.getData && e.dataTransfer.getData(CRM_STAGE_DRAG_TYPE)) || crmDraggedStageId;
          if (!fromStageId || fromStageId === stageId) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          var rect = col.getBoundingClientRect();
          var after = e.clientX > rect.left + rect.width / 2;
          crmClearStageDropHints();
          col.classList.add(after ? "crmStageDropAfter" : "crmStageDropBefore");
        });
        col.addEventListener("dragleave", function(e){
          if (!col.contains(e.relatedTarget)) {
            col.classList.remove("crmStageDropBefore", "crmStageDropAfter");
          }
        });
        col.addEventListener("drop", function(e){
          var fromStageId = (e.dataTransfer && e.dataTransfer.getData && e.dataTransfer.getData(CRM_STAGE_DRAG_TYPE)) || crmDraggedStageId;
          if (!fromStageId || fromStageId === stageId) return;
          e.preventDefault();
          var rect = col.getBoundingClientRect();
          var after = e.clientX > rect.left + rect.width / 2;
          crmClearStageDropHints();
          if (crmReorderStage(p, fromStageId, stageId, after)) {
            crmRender();
            crmQueueSave();
          }
        });

        var head = document.createElement("div");
        head.className = "crmColHead";

        var title = document.createElement("div");
        title.className = "crmColTitle";
        var count = (st.leadIds || []).length;
        var stageName = escapeHtml(st.name || "Etapa");
        var autoMsgCount = crmStageMessageCount(st);
        title.innerHTML = "<div class='crmStageTitleRow'>" +
                            "<button type='button' class='crmStageIcon crmStageIconPicker' title='Trocar ícone da etapa' aria-label='Trocar ícone da etapa'><i class='ph " + crmStageIconName(st, idx) + "'></i></button>" +
                            "<div class='crmStageTitleText'><b title='" + stageName + "'>" + stageName + "</b><small>Etapa " + (idx + 1) + "</small></div>" +
                            "<span class='crmStageDragHint' title='Arraste para mudar a posição da etapa'><i class='ph ph-dots-six-vertical'></i></span>" +
                          "</div>" +
                          "<span class='crmStageCount'><i class='ph ph-user-circle'></i>" + count + " lead(s)</span>" +
                          (autoMsgCount ? "<span class='crmStageAutoMsgBadge'><i class='ph ph-paper-plane-tilt'></i> " + (autoMsgCount > 1 ? (autoMsgCount + " mensagens") : "Mensagem ativa") + "</span>" : "");

        var btnIconPicker = title.querySelector(".crmStageIconPicker");
        if (btnIconPicker) {
          btnIconPicker.addEventListener("click", function(e){
            e.preventDefault();
            e.stopPropagation();
            crmOpenStageIconPicker(p.id, stageId);
          });
        }

        var actions = document.createElement("div");
        actions.className = "crmColActions";
        actions.innerHTML =
          "<button class='btnMini crmStageMessage' title='Mensagem automática da etapa'><i class='ph ph-chat-circle-text'></i></button>" +
          "<button class='btnMini crmStageColor' title='Alterar cor da etapa'><i class='ph ph-palette'></i></button>" +
          "<button class='btnMini crmStageEdit' title='Renomear etapa'>" + iconMarkup("edit", "Renomear", "sm") + "</button>" +
          "<button class='btnMini crmStageDelete' title='Excluir etapa'>" + iconMarkup("trash", "Excluir", "sm") + "</button>";

        var btnMsg = actions.querySelector(".crmStageMessage");
        var btnColor = actions.querySelector(".crmStageColor");
        var btnRen = actions.querySelector(".crmStageEdit");
        var btnDel = actions.querySelector(".crmStageDelete");

        btnMsg.addEventListener("click", function(e){
          e.stopPropagation();
          crmOpenStageMessage(p.id, stageId);
        });
        btnColor.addEventListener("click", function(e){
          e.stopPropagation();
          crmOpenStageColorPicker(p.id, stageId);
        });
        btnRen.addEventListener("click", async function(e){
          e.stopPropagation();
          var nn = await crmPromptRename("etapa", st.name);
          if (!nn) return;
          st.name = nn;
          crmRenderBoard();
          crmRenderSummary();
          crmQueueSave();
        });
        btnDel.addEventListener("click", async function(e){
          e.stopPropagation();
          if (!(await crmConfirm("Excluir a etapa '" + st.name + "'? Os leads continuam existindo, mas sairão desta etapa."))) return;
          // ao excluir: leads viram "sem etapa" (não perde lead)
          delete p.stages[stageId];
          p.stageOrder = p.stageOrder.filter(function(x){ return x !== stageId; });
          crmRender();
          crmQueueSave();
        });

        head.appendChild(title);
        head.appendChild(actions);

        var body = document.createElement("div");
        body.className = "crmColBody";
        body.dataset.stageId = stageId;

        body.addEventListener("dragover", function(e){
          if (crmDraggedStageId || crmDragHasType(e, CRM_STAGE_DRAG_TYPE)) return;
          e.preventDefault();
          body.classList.add("crmDropHint");
        });
        body.addEventListener("dragleave", function(){ body.classList.remove("crmDropHint"); });
        body.addEventListener("drop", function(e){
          if (crmDraggedStageId || crmDragHasType(e, CRM_STAGE_DRAG_TYPE)) return;
          e.preventDefault();
          body.classList.remove("crmDropHint");
          var leadIds = (crmDraggedLeadIds && crmDraggedLeadIds.length) ? crmDraggedLeadIds.slice() : [];
          var rawLeadData = "";
          try { rawLeadData = e.dataTransfer.getData(CRM_LEAD_DRAG_TYPE) || e.dataTransfer.getData("text/plain"); } catch(err) {}
          rawLeadData = String(rawLeadData || "");
          if (!leadIds.length && rawLeadData && rawLeadData.indexOf("stage:") !== 0) {
            rawLeadData.replace(/^leads:/, "").split(",").forEach(function(id){
              id = String(id || "").trim();
              if (id && leadIds.indexOf(id) === -1) leadIds.push(id);
            });
          }
          if (!leadIds.length) return;
          crmMoveLeadsToStage(leadIds, stageId, !!crmBulkMode);
        });

        (st.leadIds || []).forEach(function(leadId){
          var lead = crmLeadById[leadId];
          var card = crmMakeCard(leadId, lead, st, p);
          body.appendChild(card);
        });
        if (!(st.leadIds || []).length) {
          var empty = document.createElement("div");
          empty.className = "crmStageEmpty";
          empty.innerHTML = "<i class='ph ph-tray'></i><b>Nenhum lead nesta etapa</b><span>Arraste um card para cá ou cadastre um novo lead.</span>";
          body.appendChild(empty);
        }

        col.appendChild(head);
        col.appendChild(body);
        crmBoard.appendChild(col);
      });
    }

    function crmFormatDate(iso){
      if (!iso) return "";
      try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleString("pt-BR");
      } catch(e) {
        return String(iso);
      }
    }

    function crmMakeCard(leadId, lead, stage, pipeline){
      var card = document.createElement("div");
      card.className = "crmCard" + (crmSelectedLeadIds[leadId] ? " crmCardSelected" : "");
      card.draggable = true;
      card.dataset.leadId = leadId;

      var nome = (lead && lead.nome) ? lead.nome : ("Lead " + leadId.slice(0,6));
      var contato = "";
      if (lead) {
        contato = lead.whatsapp_raw || lead.email || "";
        if (!contato) contato = lead.whatsapp_digits || "";
      }
      var origem = lead && lead.source ? lead.source : (lead && lead.origem ? lead.origem : "");
      var created = lead && lead.createdAt ? crmFormatDate(lead.createdAt) : "";

      var safeNome = escapeHtml(nome);
      var safeContato = escapeHtml(contato);
      var safeOrigem = escapeHtml(origem);
      var safeCreated = escapeHtml(created);
      var safeStage = escapeHtml(stage.name || "—");
      var statusVal = leadStatusValue(lead);
      var safeStatusVal = escapeHtml(statusVal);
      var safeStatusLabel = escapeHtml(leadStatusLabel(lead));

      card.innerHTML =
        "<div class='crmCardAccent'></div>" +
        "<label class='crmCardCheckWrap' title='Selecionar lead'><input type='checkbox' class='crmCardCheck' " + (crmSelectedLeadIds[leadId] ? "checked" : "") + "></label>" +
        "<div class='crmCardTop'>" +
          "<div class='crmCardIdentity'>" +
            "<span class='crmAvatar'>" + safeNome.slice(0,1).toUpperCase() + "</span>" +
            "<div class='crmCardIdentityText'>" +
              "<div class='crmNameLine'><span class='crmLeadStatusDot status-" + safeStatusVal + "' title='" + safeStatusLabel + "'></span><div class='crmName' title='" + safeNome.replace(/'/g,"&#39;") + "'>" + safeNome + "</div></div>" +
              "<div class='crmStageBadge'><i class='ph ph-arrow-elbow-down-right'></i>" + safeStage + "</div>" +
            "</div>" +
          "</div>" +
          "<div class='crmCardBtns'>" +
            "<button class='btnMini crmCardMove' title='Mover para outra etapa'><i class='ph ph-arrows-left-right'></i></button>" +
            "<button class='btnMini crmCardChat' title='Conversar com este lead'><i class='ph ph-whatsapp-logo'></i></button>" +
            "<button class='btnMini crmCardView' title='Ver detalhes'>" + iconMarkup("eye", "Detalhes", "sm") + "</button>" +
            "<button class='btnMini crmCardRemove' title='Remover lead deste funil'><i class='ph ph-trash'></i></button>" +
          "</div>" +
        "</div>" +
        "<div class='crmMeta'>" +
          (safeContato ? ("<div class='crmMetaLine'>" + iconMarkup("contact", "Contato", "crmMetaIcon") + "<span>" + safeContato + "</span></div>") : "") +
          (safeOrigem ? ("<div class='crmMetaLine'><i class='ph ph-git-branch crmMetaPh'></i><span>" + safeOrigem + "</span></div>") : "") +
          (safeCreated ? ("<div class='crmMetaLine'><i class='ph ph-clock crmMetaPh'></i><span>" + safeCreated + "</span></div>") : "") +
        "</div>";

      var btnMove = card.querySelector(".crmCardMove");
      var btnChat = card.querySelector(".crmCardChat");
      var btnView = card.querySelector(".crmCardView");
      var btnRemove = card.querySelector(".crmCardRemove");
      var check = card.querySelector(".crmCardCheck");

      if (check) check.addEventListener("click", function(e){
        e.stopPropagation();
        crmToggleLeadSelection(leadId, check.checked);
      });
      btnMove.addEventListener("click", function(e){
        e.stopPropagation();
        crmOpenMoveMenu(leadId, pipeline);
      });
      btnChat.addEventListener("click", function(e){
        e.stopPropagation();
        crmOpenLeadChat(leadId);
      });
      btnView.addEventListener("click", function(e){
        e.stopPropagation();
        crmOpenLeadDetails(leadId);
      });
      btnRemove.addEventListener("click", async function(e){
        e.stopPropagation();
        if (!(await crmConfirm("Remover este lead do funil? Ele continuará existindo na base de leads e nas conversas."))) return;
        crmRemoveLeadsFromFunnel([leadId], false);
      });
      card.addEventListener("click", function(e){
        if (!crmBulkMode) return;
        if (e.target && e.target.closest && e.target.closest("button")) return;
        var next = !crmSelectedLeadIds[leadId];
        crmToggleLeadSelection(leadId, next);
        var cb = card.querySelector(".crmCardCheck");
        if (cb) cb.checked = next;
      });
      card.addEventListener("dblclick", function(){ if (!crmBulkMode) crmOpenLeadDetails(leadId); });

      card.addEventListener("dragstart", function(e){
        e.stopPropagation();
        card.classList.add("dragging");
        var idsToDrag = [leadId];
        if (crmBulkMode && crmSelectedLeadIds[leadId]) {
          idsToDrag = crmSelectedLeadIdList();
          if (idsToDrag.indexOf(leadId) === -1) idsToDrag.unshift(leadId);
        }
        crmDraggedLeadIds = idsToDrag.slice();
        try {
          e.dataTransfer.setData(CRM_LEAD_DRAG_TYPE, idsToDrag.join(","));
          e.dataTransfer.setData("text/plain", idsToDrag.length > 1 ? ("leads:" + idsToDrag.join(",")) : leadId);
          e.dataTransfer.effectAllowed = "move";
        } catch(err) {}
      });
      card.addEventListener("dragend", function(e){
        e.stopPropagation();
        crmDraggedLeadIds = [];
        card.classList.remove("dragging");
      });
      return card;
    }

    function crmRemoveLeadEverywhere(pipeline, leadId){
      if (!pipeline) return;
      (pipeline.stageOrder || []).forEach(function(sid){
        var st = pipeline.stages && pipeline.stages[sid];
        if (!st) return;
        st.leadIds = (st.leadIds || []).filter(function(x){ return x !== leadId; });
      });
    }

    function crmRemoveLeadsEverywhere(pipeline, leadIds){
      if (!pipeline) return;
      var lookup = Object.create(null);
      (leadIds || []).forEach(function(id){ if (id) lookup[id] = true; });
      (pipeline.stageOrder || []).forEach(function(sid){
        var st = pipeline.stages && pipeline.stages[sid];
        if (!st) return;
        st.leadIds = (st.leadIds || []).filter(function(x){ return !lookup[x]; });
      });
    }

    function crmMoveLeadsToStage(leadIds, toStageId, keepBulkMode){
      var p = crmActivePipeline();
      if (!p || !p.stages || !p.stages[toStageId]) return;
      var ids = [];
      (leadIds || []).forEach(function(id){ if (id && ids.indexOf(id) === -1) ids.push(id); });
      if (!ids.length) return;
      crmRemoveLeadsEverywhere(p, ids);
      p.stages[toStageId].leadIds = p.stages[toStageId].leadIds || [];
      ids.forEach(function(id){ if (p.stages[toStageId].leadIds.indexOf(id) === -1) p.stages[toStageId].leadIds.push(id); });
      if (!keepBulkMode) crmSelectedLeadIds = Object.create(null);
      crmRenderBoard();
      crmRenderSummary();
      crmRenderBulkToolbar();
      crmQueueSave();
      toast("ok", "Funil de Vendas", ids.length + " lead(s) movido(s).");
    }

    function crmMoveLeadToStage(leadId, toStageId){
      crmMoveLeadsToStage([leadId], toStageId, false);
    }

    function crmRemoveLeadsFromFunnel(leadIds, keepBulkMode){
      var p = crmActivePipeline();
      if (!p) return;
      var ids = [];
      (leadIds || []).forEach(function(id){ if (id && ids.indexOf(id) === -1) ids.push(id); });
      if (!ids.length) return;
      crmRemoveLeadsEverywhere(p, ids);
      ids.forEach(function(id){ delete crmSelectedLeadIds[id]; });
      if (!keepBulkMode) crmSelectedLeadIds = Object.create(null);
      crmRenderBoard();
      crmRenderSummary();
      crmRenderBulkToolbar();
      crmQueueSave();
      toast("ok", "Funil de Vendas", ids.length + " lead(s) removido(s) do funil.");
    }

    function crmOpenMoveMenu(leadId, pipeline){
      var wrap = document.createElement("div");
      var row = document.createElement("div");
      row.className = "crmFormRow";
      var label = document.createElement("label");
      label.innerHTML = "Mover para etapa<select id='crmMoveSelect'></select>";
      row.appendChild(label);
      wrap.appendChild(row);

      var sel = label.querySelector("select");
      (pipeline.stageOrder || []).forEach(function(sid){
        var st = pipeline.stages[sid];
        var opt = document.createElement("option");
        opt.value = sid;
        opt.textContent = st.name;
        sel.appendChild(opt);
      });

      var btnRow = document.createElement("div");
      btnRow.style.display = "flex";
      btnRow.style.gap = "8px";
      btnRow.style.marginTop = "12px";
      btnRow.style.justifyContent = "flex-end";
      btnRow.innerHTML = "<button class='btn' type='button'>Cancelar</button><button class='btn btnPrimary' type='button'>Mover</button>";
      wrap.appendChild(btnRow);

      btnRow.children[0].addEventListener("click", crmCloseModal);
      btnRow.children[1].addEventListener("click", function(){
        crmMoveLeadToStage(leadId, sel.value);
        crmCloseModal();
      });

      crmOpenModal("Mover lead", "Escolha a etapa de destino.", wrap);
    }

    function crmOpenLeadDetails(leadId){
      var lead = crmLeadById[leadId] || null;
      var p = crmActivePipeline();
      var stageName = "";
      if (p) {
        (p.stageOrder || []).some(function(sid){
          var st = p.stages[sid];
          if ((st.leadIds || []).includes(leadId)) { stageName = st.name; return true; }
          return false;
        });
      }
      var box = document.createElement("div");
      box.className = "crmList";
      function add(k,v){
        var it = document.createElement("div");
        it.className = "crmListItem";
        var content = document.createElement("div");
        content.className = "crmLeadDetailContent";
        var label = document.createElement("b");
        label.textContent = String(k == null ? "" : k);
        var value = document.createElement("small");
        value.textContent = String(v == null || v === "" ? "—" : v);
        content.appendChild(label);
        content.appendChild(value);
        it.appendChild(content);
        box.appendChild(it);
      }
      add("Nome", lead && lead.nome);
      add("WhatsApp", lead && (lead.whatsapp_raw || lead.whatsapp_digits));
      add("E-mail", lead && lead.email);
      add("Origem", lead && (lead.source || lead.origem));
      add("Criado em", lead && lead.createdAt ? crmFormatDate(lead.createdAt) : "");
      add("Status", stageName || "—");
      add("Empresa", lead && lead.empresa);
      add("Website", lead && lead.website);
      add("Já anuncia", lead && lead.jaAnuncia);

      crmOpenModal("Detalhes do lead", "Lead ID: " + leadId, box);
    }

    async function crmAddPipeline(){
      var name = await uiPrompt("Novo funil", "Dê um nome para organizar este fluxo de vendas.", "Novo Funil", { okText: "Criar funil", icon: "ph-kanban" });
      if (name == null) return;
      name = String(name).trim();
      if (!name) return;
      var np = {
        id: crmId("pipe"),
        name: name,
        createdAt: new Date().toISOString(),
        stageOrder: [],
        stages: {}
      };
      // cria 1 etapa default
      var s0 = { id: crmId("stg"), name: "Novo lead", leadIds: [] };
      np.stageOrder.push(s0.id);
      np.stages[s0.id] = s0;

      crmState.pipelines = crmState.pipelines || [];
      crmState.pipelines.push(np);
      crmState.activePipelineId = np.id;
      crmRender();
      crmQueueSave();
    }

    async function crmAddStage(){
      var p = crmActivePipeline();
      if (!p) return;
      var name = await uiPrompt("Nova etapa", "Digite o nome da nova etapa do funil.", "Nova etapa", { okText: "Criar etapa", icon: "ph-columns" });
      if (name == null) return;
      name = String(name).trim();
      if (!name) return;
      var st = { id: crmId("stg"), name: name, leadIds: [] };
      p.stages = p.stages || {};
      p.stageOrder = p.stageOrder || [];
      p.stages[st.id] = st;
      p.stageOrder.push(st.id);
      crmRenderBoard();
      crmQueueSave();
    }

    async function crmOpenImportLead(){
      var p = crmActivePipeline();
      if (!p) return;

      try {
        if (typeof fetchTags === "function" && (!Array.isArray(cachedTags) || !cachedTags.length)) await fetchTags();
      } catch(e) {}
      try {
        if (typeof loadWebhooks === "function" && !webhooksLoadedOnce) {
          await loadWebhooks();
          webhooksLoadedOnce = true;
        }
      } catch(e) {}

      var wrap = document.createElement("div");
      wrap.className = "crmImportLeadWrap";
      wrap.innerHTML =
        "" +
        "<div class='crmImportFilters'>" +
          "<div class='crmImportGrid'>" +
            "<label>Buscar<input id='crmImpQ' placeholder='nome, email, whatsapp, empresa...'></label>" +
            "<label>Etapa destino<select id='crmImpStage'></select></label>" +
            "<label>Origem / webhook<select id='crmImpOrigin'><option value=''>Todas as origens</option></select></label>" +
            "<label>Tag<select id='crmImpTag'><option value=''>Todas as tags</option></select></label>" +
            "<label>Tag contém<input id='crmImpTagText' placeholder='parte do nome da tag'></label>" +
            "<label>Status WhatsApp<select id='crmImpStatus'>" +
              "<option value=''>Todos</option><option value='replied'>Responderam</option><option value='delivered'>Receberam</option><option value='pending'>Pendentes</option><option value='notDelivered'>Não receberam</option><option value='notExists'>Não existem</option><option value='none'>Sem envio</option>" +
            "</select></label>" +
            "<label>Período inicial<input id='crmImpFrom' type='date'></label>" +
            "<label>Período final<input id='crmImpTo' type='date'></label>" +
            "<label>DDD / país<input id='crmImpDdd' placeholder='Ex: 11, 31, 351'></label>" +
            "<label>Já anuncia<select id='crmImpAnuncia'><option value=''>Todos</option><option value='sim'>Sim</option><option value='nao'>Não</option><option value='vazio'>Sem informação</option></select></label>" +
            "<label>Contato<select id='crmImpContato'><option value=''>Todos</option><option value='whatsapp'>Com WhatsApp</option><option value='email'>Com e-mail</option><option value='both'>Com WhatsApp e e-mail</option><option value='no_whatsapp'>Sem WhatsApp</option><option value='no_email'>Sem e-mail</option></select></label>" +
            "<label>Funil<select id='crmImpPlacement'><option value='outside'>Somente fora deste funil</option><option value='inside'>Somente já neste funil</option><option value='all'>Todos</option></select></label>" +
          "</div>" +
          "<div class='crmImportActions'>" +
            "<div class='crmImportActionsLeft'>" +
              "<button class='btn btnGhost' id='crmImpClear' type='button'><i class='ph ph-eraser'></i> Limpar filtros</button>" +
              "<span class='crmImportCount' id='crmImpCount'>Calculando...</span>" +
            "</div>" +
            "<div class='crmImportActionsRight'>" +
              "<button class='btn btnPrimary' id='crmImpAddAll' type='button'><i class='ph ph-plus-circle'></i> Adicionar todos de uma vez</button>" +
            "</div>" +
          "</div>" +
        "</div>" +
        "<div class='crmImportListHead'><div><b>Leads encontrados</b><br><span>Use os filtros acima para importar apenas os leads certos para a etapa escolhida.</span></div><div class='crmImportListHeadActions'><span id='crmImpLimitHint'></span><button class='btn btnPrimary' id='crmImpAddAllTop' type='button'><i class='ph ph-plus-circle'></i> Adicionar todos de uma vez</button></div></div>";

      var stageSel = wrap.querySelector("#crmImpStage");
      (p.stageOrder || []).forEach(function(sid){
        var st = p.stages && p.stages[sid];
        if (!st) return;
        var opt = document.createElement("option");
        opt.value = sid;
        opt.textContent = st.name;
        stageSel.appendChild(opt);
      });

      var originSel = wrap.querySelector("#crmImpOrigin");
      var tagSel = wrap.querySelector("#crmImpTag");
      var countEl = wrap.querySelector("#crmImpCount");
      var limitHint = wrap.querySelector("#crmImpLimitHint");
      var addAllBtn = wrap.querySelector("#crmImpAddAll");
      var addAllTopBtn = wrap.querySelector("#crmImpAddAllTop");
      var clearBtn = wrap.querySelector("#crmImpClear");

      var list = document.createElement("div");
      list.className = "crmList";
      wrap.appendChild(list);

      var placed = crmAllPlacedLeadIds(p);
      var filteredCache = [];

      function crmImpNorm(value){
        return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
      }
      function crmImpDigits(value){ return String(value || "").replace(/\D+/g, ""); }
      function crmImpDateOnly(value){
        if (!value) return "";
        var s = String(value);
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
        var d = new Date(value);
        if (isNaN(d.getTime())) return "";
        return d.toISOString().slice(0, 10);
      }
      function crmImpLeadOriginLabel(lead){
        var meta = lead && lead.sourceMeta && typeof lead.sourceMeta === "object" ? lead.sourceMeta : null;
        return (meta && (meta.webhookName || meta.name || meta.webhookId)) ||
          (lead && (lead.originLabel || lead.origem || lead.sourceDetail || lead.source)) ||
          "Sem origem";
      }
      function crmImpLeadOriginHay(lead){
        var meta = lead && lead.sourceMeta && typeof lead.sourceMeta === "object" ? lead.sourceMeta : null;
        return crmImpNorm([
          lead && lead.source,
          lead && lead.origem,
          lead && lead.originLabel,
          lead && lead.originDetail,
          lead && lead.sourceDetail,
          meta && meta.type,
          meta && meta.webhookId,
          meta && meta.webhookName,
          meta && meta.webhookToken,
          meta && meta.webhookUrl,
          meta && meta.payloadType
        ].filter(Boolean).join(" "));
      }
      function crmImpRawTags(lead){
        var out = [];
        function add(v){ if (v != null && String(v).trim()) out.push(String(v).trim()); }
        if (!lead) return out;
        if (Array.isArray(lead.tagIds)) lead.tagIds.forEach(add);
        if (Array.isArray(lead.tagsFull)) lead.tagsFull.forEach(function(t){ if (t) { add(t.id); add(t.name); } });
        if (Array.isArray(lead.tags)) {
          lead.tags.forEach(function(t){
            if (t && typeof t === "object") { add(t.id); add(t.name); }
            else add(t);
          });
        } else if (lead.tags) {
          String(lead.tags).split(/[,;|\n]+/).forEach(add);
        }
        return out;
      }
      function crmImpTagsHay(lead){ return crmImpNorm(crmImpRawTags(lead).join(" ")); }
      function crmImpDdd(lead){
        var d = crmImpDigits((lead && (lead.whatsapp_digits || lead.whatsapp_raw || lead.whatsapp)) || "");
        if (!d) return "";
        if (d.indexOf("55") === 0 && d.length >= 12) return d.slice(2, 4);
        if (d.indexOf("351") === 0) return "351";
        return d.slice(0, Math.min(3, d.length));
      }
      function crmImpLeadHay(lead){
        return crmImpNorm([
          lead && lead.nome,
          lead && lead.email,
          lead && lead.empresa,
          lead && lead.website,
          lead && lead.jaAnuncia,
          lead && lead.whatsapp_raw,
          lead && lead.whatsapp_digits,
          lead && lead.source,
          lead && lead.sourceDetail,
          crmImpRawTags(lead).join(" ")
        ].filter(Boolean).join(" "));
      }
      function crmImpAddOption(select, value, label){
        value = String(value || "").trim();
        label = String(label || value || "").trim();
        if (!value || !label || !select) return;
        var exists = Array.prototype.some.call(select.options, function(o){ return o.value === value; });
        if (exists) return;
        var opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label.length > 82 ? (label.slice(0, 79) + "...") : label;
        select.appendChild(opt);
      }

      function populateOriginOptions(){
        var origins = [];
        (Array.isArray(webhookItems) ? webhookItems : []).forEach(function(w){
          var label = (w && (w.displayName || w.name || w.url || w.id)) ? String(w.displayName || w.name || w.url || w.id) : "Webhook";
          origins.push({ value: crmImpNorm([w && w.id, w && w.name, w && w.displayName, w && w.url, w && w.token].filter(Boolean).join(" ")), label: label });
        });
        (Array.isArray(crmLeads) ? crmLeads : []).forEach(function(l){
          var label = crmImpLeadOriginLabel(l);
          var value = crmImpLeadOriginHay(l);
          if (value) origins.push({ value: value, label: label });
        });
        origins.sort(function(a,b){ return String(a.label).localeCompare(String(b.label), "pt-BR"); });
        origins.forEach(function(o){ crmImpAddOption(originSel, o.value, o.label); });
      }

      function populateTagOptions(){
        (Array.isArray(cachedTags) ? cachedTags : []).forEach(function(t){
          if (!t) return;
          var label = t.name || t.id;
          var value = crmImpNorm([t.id, t.name].filter(Boolean).join(" "));
          crmImpAddOption(tagSel, value, label);
        });
        var raw = Object.create(null);
        (Array.isArray(crmLeads) ? crmLeads : []).forEach(function(l){
          crmImpRawTags(l).forEach(function(t){
            var n = crmImpNorm(t);
            if (!n || n.length < 2) return;
            if (!raw[n]) raw[n] = String(t).trim();
          });
        });
        Object.keys(raw).sort(function(a,b){ return raw[a].localeCompare(raw[b], "pt-BR"); }).slice(0, 500).forEach(function(k){
          crmImpAddOption(tagSel, k, raw[k]);
        });
      }

      function getFilters(){
        return {
          q: crmImpNorm(wrap.querySelector("#crmImpQ").value),
          origin: originSel.value,
          tag: tagSel.value,
          tagText: crmImpNorm(wrap.querySelector("#crmImpTagText").value),
          status: wrap.querySelector("#crmImpStatus").value,
          from: wrap.querySelector("#crmImpFrom").value,
          to: wrap.querySelector("#crmImpTo").value,
          ddd: crmImpDigits(wrap.querySelector("#crmImpDdd").value),
          anuncia: wrap.querySelector("#crmImpAnuncia").value,
          contato: wrap.querySelector("#crmImpContato").value,
          placement: wrap.querySelector("#crmImpPlacement").value
        };
      }

      function matchesImportFilters(lead, f){
        if (!lead || !lead.id) return false;
        var isPlaced = !!placed[lead.id];
        if (f.placement === "outside" && isPlaced) return false;
        if (f.placement === "inside" && !isPlaced) return false;
        if (f.q && crmImpLeadHay(lead).indexOf(f.q) === -1 && crmImpDigits(lead.whatsapp_digits || lead.whatsapp_raw).indexOf(f.q) === -1) return false;
        if (f.origin && crmImpLeadOriginHay(lead).indexOf(f.origin) === -1) return false;
        var tagHay = crmImpTagsHay(lead);
        if (f.tag && tagHay.indexOf(f.tag) === -1) return false;
        if (f.tagText && tagHay.indexOf(f.tagText) === -1) return false;
        if (f.status && leadStatusValue(lead) !== f.status) return false;
        var date = crmImpDateOnly(lead.createdAt);
        if (f.from && (!date || date < f.from)) return false;
        if (f.to && (!date || date > f.to)) return false;
        if (f.ddd) {
          var digits = crmImpDigits(lead.whatsapp_digits || lead.whatsapp_raw || "");
          var ddd = crmImpDdd(lead);
          if (ddd !== f.ddd && digits.indexOf(f.ddd) !== 0) return false;
        }
        var anuncia = crmImpNorm(lead.jaAnuncia || "");
        if (f.anuncia === "sim" && !(anuncia === "sim" || anuncia === "s" || anuncia === "yes")) return false;
        if (f.anuncia === "nao" && !(anuncia === "nao" || anuncia === "não" || anuncia === "n" || anuncia === "no")) return false;
        if (f.anuncia === "vazio" && anuncia) return false;
        var hasWa = !!crmImpDigits(lead.whatsapp_digits || lead.whatsapp_raw || "");
        var hasEmail = !!String(lead.email || "").trim();
        if (f.contato === "whatsapp" && !hasWa) return false;
        if (f.contato === "email" && !hasEmail) return false;
        if (f.contato === "both" && (!hasWa || !hasEmail)) return false;
        if (f.contato === "no_whatsapp" && hasWa) return false;
        if (f.contato === "no_email" && hasEmail) return false;
        return true;
      }

      function renderList(){
        list.innerHTML = "";
        var f = getFilters();
        var items = (Array.isArray(crmLeads) ? crmLeads : []).filter(function(l){ return matchesImportFilters(l, f); });
        items.sort(function(a,b){ return String(b.createdAt || "").localeCompare(String(a.createdAt || "")); });
        filteredCache = items;

        var outsideCount = items.filter(function(l){ return !placed[l.id]; }).length;
        var insideCount = items.length - outsideCount;
        countEl.textContent = items.length + " lead(s) encontrados" + (insideCount ? (" · " + insideCount + " já no funil") : "");
        var addAllDisabled = !items.length || !stageSel.value;
        addAllBtn.disabled = addAllDisabled;
        if (addAllTopBtn) addAllTopBtn.disabled = addAllDisabled;

        var shown = items.slice(0, 120);
        limitHint.textContent = items.length > shown.length ? ("Mostrando 120 de " + items.length + ". Refine os filtros para ver menos leads.") : "";

        if (!shown.length) {
          var empty = document.createElement("div");
          empty.className = "hint";
          empty.style.padding = "14px";
          empty.textContent = "Nenhum lead encontrado com esses filtros.";
          list.appendChild(empty);
          return;
        }

        shown.forEach(function(l){
          var it = document.createElement("div");
          it.className = "crmListItem";
          var contato = l.whatsapp_raw || l.email || l.whatsapp_digits || "";
          var dateLabel = l.createdAt ? crmFormatDate(l.createdAt) : "Sem data";
          var originLabel = crmImpLeadOriginLabel(l);
          var statusLabel = leadStatusLabel(l);
          var already = !!placed[l.id];
          var rawTags = crmImpRawTags(l).slice(0, 4);
          var tagHtml = rawTags.length ? rawTags.map(function(t){ return "<span class='crmImportPill'><i class='ph ph-tag'></i><span>" + escapeHtml(t) + "</span></span>"; }).join("") : "";
          it.innerHTML =
            "<div style='min-width:0;flex:1 1 auto;'>" +
              "<b style='display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'>" + escapeHtml(l.nome || "—") + "</b>" +
              "<small style='display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'>" + escapeHtml(contato) + (l.empresa ? (" • " + escapeHtml(l.empresa)) : "") + "</small>" +
              "<div class='crmImportLeadMeta'>" +
                "<span class='crmImportPill blue'><i class='ph ph-webhooks-logo'></i><span>" + escapeHtml(originLabel) + "</span></span>" +
                "<span class='crmImportPill'><i class='ph ph-calendar'></i><span>" + escapeHtml(dateLabel) + "</span></span>" +
                "<span class='crmImportPill'><i class='ph ph-whatsapp-logo'></i><span>" + escapeHtml(statusLabel) + "</span></span>" +
                (already ? "<span class='crmImportPill warn'><i class='ph ph-funnel'></i><span>Já no funil</span></span>" : "<span class='crmImportPill ok'><i class='ph ph-plus-circle'></i><span>Fora do funil</span></span>") +
                tagHtml +
              "</div>" +
            "</div>" +
            "<button class='btn btnPrimary' type='button'>" + (already ? "Mover" : "Adicionar") + "</button>";
          it.querySelector("button").addEventListener("click", function(){
            crmMoveLeadToStage(l.id, stageSel.value);
            placed[l.id] = true;
            renderList();
          });
          list.appendChild(it);
        });
      }

      function resetFilters(){
        ["#crmImpQ", "#crmImpTagText", "#crmImpFrom", "#crmImpTo", "#crmImpDdd"].forEach(function(id){ var el = wrap.querySelector(id); if (el) el.value = ""; });
        ["#crmImpOrigin", "#crmImpTag", "#crmImpStatus", "#crmImpAnuncia", "#crmImpContato"].forEach(function(id){ var el = wrap.querySelector(id); if (el) el.value = ""; });
        var placement = wrap.querySelector("#crmImpPlacement");
        if (placement) placement.value = "outside";
        renderList();
      }

      populateOriginOptions();
      populateTagOptions();

      Array.prototype.forEach.call(wrap.querySelectorAll("input,select"), function(el){
        if (el.id === "crmImpStage") return;
        el.addEventListener("input", renderList);
        el.addEventListener("change", renderList);
      });
      stageSel.addEventListener("change", function(){
        var disabled = !filteredCache.length || !stageSel.value;
        addAllBtn.disabled = disabled;
        if (addAllTopBtn) addAllTopBtn.disabled = disabled;
      });
      clearBtn.addEventListener("click", resetFilters);
      async function crmImpAddAllFiltered(){
        var ids = filteredCache.map(function(l){ return l && l.id; }).filter(Boolean);
        if (!ids.length) return;
        var ok = await crmConfirm("Adicionar todos os " + ids.length + " leads encontrados pelos filtros à etapa selecionada?");
        if (!ok) return;
        crmMoveLeadsToStage(ids, stageSel.value, false);
        ids.forEach(function(id){ placed[id] = true; });
        renderList();
      }
      addAllBtn.addEventListener("click", crmImpAddAllFiltered);
      if (addAllTopBtn) addAllTopBtn.addEventListener("click", crmImpAddAllFiltered);

      renderList();
      crmOpenModal("Importar lead", "Filtre por webhook, período, tag, status, DDD e dados do contato antes de adicionar ao funil.", wrap);
    }


    function crmOpenNewLead(){
      var p = crmActivePipeline();
      if (!p) return;

      var wrap = document.createElement("div");
      var row1 = document.createElement("div");
      row1.className = "crmFormRow";
      row1.innerHTML =
        "<label>Nome<input id='crmNewNome' placeholder='Nome do lead'></label>" +
        "<label>E-mail<input id='crmNewEmail' placeholder='email@exemplo.com'></label>" +
        "<label>WhatsApp<input id='crmNewZap' placeholder='(11) 99999-9999'></label>";
      wrap.appendChild(row1);

      var row2 = document.createElement("div");
      row2.className = "crmFormRow";
      row2.style.marginTop = "10px";
      row2.innerHTML =
        "<label>Origem<input id='crmNewSource' placeholder='manual'></label>" +
        "<label>Etapa<select id='crmNewStage'></select></label>";
      wrap.appendChild(row2);

      var sel = row2.querySelector("#crmNewStage");
      (p.stageOrder || []).forEach(function(sid){
        var st = p.stages[sid];
        var opt = document.createElement("option");
        opt.value = sid;
        opt.textContent = st.name;
        sel.appendChild(opt);
      });

      var btnRow = document.createElement("div");
      btnRow.style.display = "flex";
      btnRow.style.gap = "8px";
      btnRow.style.marginTop = "12px";
      btnRow.style.justifyContent = "flex-end";
      btnRow.innerHTML = "<button class='btn' type='button'>Cancelar</button><button class='btn btnPrimary' type='button'>Criar</button>";
      wrap.appendChild(btnRow);

      btnRow.children[0].addEventListener("click", crmCloseModal);
      btnRow.children[1].addEventListener("click", async function(){
        var nome = row1.querySelector("#crmNewNome").value.trim();
        var email = row1.querySelector("#crmNewEmail").value.trim();
        var whatsapp = row1.querySelector("#crmNewZap").value.trim();
        var source = row2.querySelector("#crmNewSource").value.trim() || "manual";
        if (!nome) { toast("warn", "Novo lead", "Nome é obrigatório."); return; }
        if (!email && !whatsapp) { toast("warn", "Novo lead", "Informe e-mail ou WhatsApp."); return; }
        try {
          var j = await crmFetchJson(CRM_API_PREFIX + "/leads/manual", {
            method: "POST",
            body: JSON.stringify({ nome: nome, email: email, whatsapp: whatsapp, source: source })
          });
          var lead = j.lead;
          crmLeads.unshift(lead);
          crmLeadById[lead.id] = lead;
          crmMoveLeadToStage(lead.id, sel.value);
          crmCloseModal();
        } catch (e) {
          toast("err", "Novo lead", "Erro ao criar lead: " + e.message);
        }
      });

      crmOpenModal("Novo lead manual", "Cria lead e adiciona direto no funil.", wrap);
    }

    function crmRender(){
      if (!crmState) return;
      crmRenderSummary();
      crmRenderTabs();
      crmRenderBoard();
      crmRenderBulkToolbar();
    }

    async function crmBoot(){
      if (crmLoadedOnce) return;
      crmLoadedOnce = true;
      try {
        await crmLoad();
        crmRender();
      } catch (e) {
        console.error(e);
        toast("err", "Funil de Vendas", "Falha ao carregar CRM: " + e.message);
      }
    }

    if (crmBtnNewPipeline) crmBtnNewPipeline.addEventListener("click", crmAddPipeline);
    if (crmBtnNewStage) crmBtnNewStage.addEventListener("click", crmAddStage);
    if (crmBtnImportLead) crmBtnImportLead.addEventListener("click", crmOpenImportLead);
    if (crmBtnBulkMode) crmBtnBulkMode.addEventListener("click", function(){ crmSetBulkMode(!crmBulkMode); });
    if (crmBtnLinkWebhook) crmBtnLinkWebhook.addEventListener("click", crmOpenWebhookLink);
    if (crmBtnNewLead) crmBtnNewLead.addEventListener("click", crmOpenNewLead);




(function(){
  function setPagerVisible(v){
    var bar = document.getElementById('pagerBar') || document.getElementById('pageBar') || document.querySelector('[data-pager]') || document.querySelector('.pager');
    if(!bar) return;
    bar.classList.toggle('is-hidden', !v);
    bar.style.display = v ? '' : 'none';
    document.body.classList.toggle('hasPager', !!v);
  }
  window.setPagerVisible = setPagerVisible;
  setPagerVisible(true);

  var btnLeads=document.getElementById('navLeads');
  var btnTags=document.getElementById('navTags');
  var btnChats=document.getElementById('navChats');
  var btnCrm=document.getElementById('navCrm');
  var btnCloud=document.getElementById('navCloud');
  var btnOwner=document.getElementById('navOwner');

  if(btnLeads) btnLeads.addEventListener('click', function(){ setPagerVisible(true); }, true);
  if(btnTags) btnTags.addEventListener('click', function(){ setPagerVisible(true); }, true);
  if(btnChats) btnChats.addEventListener('click', function(){ setPagerVisible(false); }, true);
  if(btnCrm) btnCrm.addEventListener('click', function(){ setPagerVisible(false); }, true);
  if(btnCloud) btnCloud.addEventListener('click', function(){ setPagerVisible(false); }, true);
  if(btnOwner) btnOwner.addEventListener('click', function(){ setPagerVisible(false); }, true);

  window.loadOwner = async function loadOwner(){
    try{
      const r=await fetch('/api/business');
      const j=await r.json();
      const o=j.owner||{};
      const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.value=v||''; };
      set('ownerName', o.name);
      set('ownerBusiness', o.business);
      set('ownerEmail', o.email);
      set('ownerWhatsapp', o.whatsapp);
    }catch(e){}
  };

  function configureOwnerPermissions(){
    var isAdmin = window.APP_TENANT === 'admin';
    var hint = document.getElementById('ownerHint');
    var saveBtn = document.getElementById('ownerSave');
    if (hint) hint.textContent = isAdmin ? 'Admin pode visualizar e editar estes dados.' : 'Visualização. Somente o Admin pode alterar.';
    document.querySelectorAll('.ownerInput').forEach(function(el){ el.disabled = !isAdmin; });
    if (saveBtn) {
      saveBtn.disabled = !isAdmin;
      if (!isAdmin) saveBtn.innerHTML = '<i class="ph ph-lock"></i> Somente admin';
    }
  }

  configureOwnerPermissions();
  window.loadOwner();

  var saveBtn=document.getElementById('ownerSave');
  if(saveBtn) saveBtn.addEventListener('click', async function(){
    if (window.APP_TENANT !== 'admin') return;
    const body={ owner:{
      name: (document.getElementById('ownerName')||{}).value||'',
      business: (document.getElementById('ownerBusiness')||{}).value||'',
      email: (document.getElementById('ownerEmail')||{}).value||'',
      whatsapp: (document.getElementById('ownerWhatsapp')||{}).value||''
    } };
    const r=await fetch('/api/business',{method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    if(r.ok) toast('ok','Dono do Negócio','Dados salvos.'); else toast('err','Dono do Negócio','Falha ao salvar.');
  });
})();



(function(){
  function isVisible(el){
    if(!el) return false;
    return el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
  }
  function restoreLeadOverview(){
    var panel=document.getElementById('panelLeads');
    var hero=document.querySelector('.dashboardHero');
    if(panel && hero){
      if(hero.parentElement !== panel){
        panel.insertBefore(hero, panel.firstElementChild);
      }
      hero.style.display='block';
      hero.style.visibility='visible';
      hero.style.opacity='1';
      hero.style.height='auto';
      hero.style.maxHeight='none';
      var body=hero.querySelector('.cardBody');
      if(body) body.style.display='block';
      var header=hero.querySelector('.cardHeader');
      if(header) header.style.display='flex';
      var kpis=hero.querySelector('.kpis');
      if(kpis) kpis.style.display='grid';
    }
  }
  function setPagerVisibleSafe(show){
    var bar=document.getElementById('pagerBar') || document.querySelector('[data-pager]') || document.querySelector('.pager');
    if(!bar) return;
    bar.classList.toggle('is-hidden', !show);
    bar.style.display=show ? '' : 'none';
    document.body.classList.toggle('hasPager', !!show);
  }
  function fixActiveSection(){
    restoreLeadOverview();
    var panel=document.getElementById('panelLeads');
    var leadsActive=document.getElementById('navLeads') && document.getElementById('navLeads').classList.contains('active');
    var showPager=!!(panel && isVisible(panel) && leadsActive);
    setPagerVisibleSafe(showPager);
  }
  function scrollLeadTop(){
    var panel=document.getElementById('panelLeads');
    if(panel && isVisible(panel)){
      try{ panel.scrollTop=0; }catch(e){}
      try{ window.scrollTo({top:0,left:0,behavior:'smooth'}); }catch(e){ window.scrollTo(0,0); }
    }
  }
  document.addEventListener('DOMContentLoaded', function(){
    fixActiveSection();
    setTimeout(fixActiveSection, 150);
    setTimeout(function(){ fixActiveSection(); scrollLeadTop(); }, 500);
    ['navLeads','navChats','navInsights','navCloud','navCrm','navOwner','navTags'].forEach(function(id){
      var btn=document.getElementById(id);
      if(!btn) return;
      btn.addEventListener('click', function(){
        setTimeout(fixActiveSection, 40);
        if(id==='navLeads' || id==='navTags') setTimeout(scrollLeadTop, 80);
      }, true);
    });
  });
  window.zapeFixLeadUi = fixActiveSection;
})();

/* ---------- Criação de painéis completos pelo Felipe ---------- */
(function bootstrapFelipeTenants(){
  var nav = document.getElementById('navUsers');
  var panel = document.getElementById('panelUsers');
  var body = document.getElementById('felipeUsersBody');
  var meta = document.getElementById('felipeUsersMeta');
  var count = document.getElementById('navUsersCount');
  var createBtn = document.getElementById('btnCreateFelipeTenant');
  if (!nav || !panel || APP_TENANT !== 'felipe') return;

  var tenants = [];

  function slugify(value){
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 32);
  }

  var nameInput = document.getElementById('felipeTenantName');
  var idInput = document.getElementById('felipeTenantId');
  if (nameInput && idInput){
    nameInput.addEventListener('input', function(){
      if (!idInput.dataset.manual) idInput.value = slugify(nameInput.value);
    });
    idInput.addEventListener('input', function(){
      idInput.dataset.manual = idInput.value ? '1' : '';
      idInput.value = slugify(idInput.value);
    });
  }

  function hideTenantPanel(){
    panel.style.display = 'none';
    nav.classList.remove('active');
  }

  function showTenantPanel(){
    ['panelLeads','panelChats','panelInsights','panelCloudMain','panelCrm','panelOwner','panelTags'].forEach(function(id){
      var el = document.getElementById(id); if (el) el.style.display = 'none';
    });
    document.querySelectorAll('.menuBtn').forEach(function(btn){ btn.classList.remove('active'); });
    nav.classList.add('active');
    panel.style.display = 'flex';
    if (typeof window.setPagerVisible === 'function') window.setPagerVisible(false);
    loadTenants();
  }

  ['navLeads','navChats','navInsights','navTags','navCloud','navCrm','navOwner'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', hideTenantPanel, true);
  });
  nav.addEventListener('click', showTenantPanel);

  function whatsappLabel(session){
    if (!session) return '<span class="usersStatus off">Sem sessão</span>';
    if (session.authenticationExists && session.requiresCleanup) return '<span class="usersStatus warn">Limpeza obrigatória</span>';
    if (session.authenticationExists) return '<span class="usersStatus">Autenticação salva</span>';
    return '<span class="usersStatus off">Não conectado</span>';
  }

  function renderTenants(){
    if (!body) return;
    count.textContent = String(tenants.length);
    meta.textContent = tenants.length + ' painel(is) completo(s)';
    body.innerHTML = '';
    if (!tenants.length){
      body.innerHTML = '<tr><td colspan="6"><div class="emptyState">Nenhum painel adicional foi criado ainda.</div></td></tr>';
      return;
    }

    tenants.forEach(function(tenant){
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td><strong>' + escapeHtml(tenant.displayName) + '</strong><div class="hint">ID: ' + escapeHtml(tenant.tenantId) + '</div></td>' +
        '<td><a class="tenantPathLink" href="/' + encodeURIComponent(tenant.tenantId) + '" target="_blank" rel="noopener">/' + escapeHtml(tenant.tenantId) + '</a></td>' +
        '<td><strong>' + escapeHtml(tenant.username) + '</strong><div class="hint">Administrador do painel</div></td>' +
        '<td>' + whatsappLabel(tenant.whatsappSession) + '</td>' +
        '<td><span class="usersStatus' + (tenant.enabled ? '' : ' off') + '">' + (tenant.enabled ? 'Ativo' : 'Desativado') + '</span></td>' +
        '<td><div class="usersActionRow"></div></td>';

      var actions = tr.querySelector('.usersActionRow');

      var open = document.createElement('a');
      open.className = 'btn btnSoft';
      open.href = '/login?tenant=' + encodeURIComponent(tenant.tenantId);
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'Abrir';

      var toggle = document.createElement('button');
      toggle.className = 'btn btnSoft';
      toggle.type = 'button';
      toggle.textContent = tenant.enabled ? 'Desativar' : 'Ativar';
      toggle.addEventListener('click', function(){ updateTenant(tenant.tenantId, { enabled: !tenant.enabled }); });

      var password = document.createElement('button');
      password.className = 'btn btnSoft';
      password.type = 'button';
      password.textContent = 'Trocar senha';
      password.addEventListener('click', function(){
        var next = window.prompt('Digite a nova senha de ' + tenant.displayName + ' (mínimo de 12 caracteres):');
        if (next === null) return;
        updateTenant(tenant.tenantId, { password: next });
      });

      var remove = document.createElement('button');
      remove.className = 'btn btnDanger';
      remove.type = 'button';
      remove.textContent = 'Excluir painel';
      remove.addEventListener('click', function(){
        var expected = 'EXCLUIR ' + tenant.tenantId.toUpperCase();
        var typed = window.prompt('A pasta de dados será preservada. Para remover o acesso, digite exatamente: ' + expected);
        if (typed === null) return;
        deleteTenant(tenant.tenantId, typed);
      });

      actions.appendChild(open);
      actions.appendChild(toggle);
      actions.appendChild(password);
      actions.appendChild(remove);
      body.appendChild(tr);
    });
  }

  async function loadTenants(){
    try{
      var r = await fetch('/api/felipe/tenants');
      var j = await r.json().catch(function(){ return {}; });
      if (!r.ok){
        nav.style.display = 'none';
        hideTenantPanel();
        return;
      }
      nav.style.display = 'flex';
      tenants = Array.isArray(j.items) ? j.items : [];
      renderTenants();
    }catch(e){
      if (meta) meta.textContent = 'Falha ao carregar';
    }
  }

  async function updateTenant(tenantId, patch){
    try{
      var r = await fetch('/api/felipe/tenants/' + encodeURIComponent(tenantId), {
        method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch || {})
      });
      var j = await r.json().catch(function(){ return {}; });
      if (!r.ok) throw new Error(j.error || 'Falha ao atualizar painel.');
      toast('ok','Painéis','Painel atualizado. As sessões de login antigas foram revogadas.');
      await loadTenants();
    }catch(e){ toast('err','Painéis',e.message || 'Falha ao atualizar.'); }
  }

  async function deleteTenant(tenantId, confirmation){
    try{
      var r = await fetch('/api/felipe/tenants/' + encodeURIComponent(tenantId), {
        method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ confirmation: confirmation })
      });
      var j = await r.json().catch(function(){ return {}; });
      if (!r.ok) throw new Error(j.error || 'Falha ao excluir painel.');
      toast('ok','Painéis','Painel removido do login. A pasta de dados foi preservada.');
      await loadTenants();
    }catch(e){ toast('err','Painéis',e.message || 'Falha ao excluir.'); }
  }

  if (createBtn) createBtn.addEventListener('click', async function(){
    var displayName = String((document.getElementById('felipeTenantName') || {}).value || '').trim();
    var tenantId = slugify((document.getElementById('felipeTenantId') || {}).value || '');
    var username = String((document.getElementById('felipeTenantUser') || {}).value || '').trim();
    var password = String((document.getElementById('felipeTenantPassword') || {}).value || '');
    if (!displayName || tenantId.length < 3 || !username || password.length < 12){
      toast('warn','Painéis','Preencha nome, identificador, usuário e uma senha com pelo menos 12 caracteres.');
      return;
    }
    createBtn.disabled = true;
    try{
      var r = await fetch('/api/felipe/tenants', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ tenantId:tenantId, displayName:displayName, username:username, password:password, enabled:true })
      });
      var j = await r.json().catch(function(){ return {}; });
      if (!r.ok) throw new Error(j.error || 'Falha ao criar painel.');
      document.getElementById('felipeTenantName').value = '';
      document.getElementById('felipeTenantId').value = '';
      document.getElementById('felipeTenantId').dataset.manual = '';
      document.getElementById('felipeTenantUser').value = '';
      document.getElementById('felipeTenantPassword').value = '';
      toast('ok','Painéis','Novo painel completo criado. Ele já possui dados e sessão do WhatsApp isolados.');
      await loadTenants();
    }catch(e){ toast('err','Painéis',e.message || 'Falha ao criar painel.'); }
    finally{ createBtn.disabled = false; }
  });

  loadTenants();
})();
