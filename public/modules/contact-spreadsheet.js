'use strict';

(function bootstrapContactSpreadsheet(global) {
  var card = document.getElementById('contactSpreadsheetCard');
  if (!card || !global.zapeAppConfig || !global.zapeApi) return;
  var base = global.zapeAppConfig.active.apiBase + '/contact-spreadsheet';
  var summary = document.getElementById('contactSpreadsheetSummary');
  var local = document.getElementById('contactSpreadsheetLocal');
  var google = document.getElementById('contactSpreadsheetGoogle');
  var download = document.getElementById('contactSpreadsheetDownload');
  var openGoogle = document.getElementById('contactSpreadsheetOpenGoogle');
  var sync = document.getElementById('contactSpreadsheetSync');
  var feedback = document.getElementById('contactSpreadsheetFeedback');
  var busy = false;
  var forbidden = false;

  function date(value) {
    if (!value) return 'aguardando';
    var parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'aguardando' : parsed.toLocaleString('pt-BR');
  }
  function render(state) {
    var count = Number(state.count || 0).toLocaleString('pt-BR');
    summary.textContent = state.enabled ? count + ' contato(s) na c\u00f3pia autom\u00e1tica desta conta. Sem os filtros da lista.' : 'Atualiza\u00e7\u00e3o autom\u00e1tica desativada no servidor.';
    local.textContent = state.local.error ? state.local.error.message
      : state.local.ready ? 'CSV atualizado em ' + date(state.local.updatedAt) + '. Verificado em ' + date(state.local.checkedAt) + '.'
        : 'Preparando a planilha com os contatos j\u00e1 cadastrados...';
    download.disabled = !state.enabled;
    sync.disabled = !state.enabled;
    var gs = state.google || {};
    google.textContent = !gs.enabled ? 'Google Sheets opcional: configure a planilha de destino e a conta de servi\u00e7o no servidor. O CSV funciona sem essa configura\u00e7\u00e3o.'
      : gs.error ? gs.error.message + (gs.nextAttemptAt ? ' Nova tentativa a partir de ' + date(gs.nextAttemptAt) + '.' : '')
        : gs.state === 'synced' ? 'Google Sheets atualizado em ' + date(gs.updatedAt) + '.'
          : gs.state === 'syncing' ? 'Sincronizando com Google Sheets. O cadastro dos contatos continua normalmente.'
            : 'Google Sheets aguardando sincroniza\u00e7\u00e3o autom\u00e1tica.';
    if (gs.url && /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+\/edit(?:#gid=\d+)?$/.test(gs.url)) {
      openGoogle.href = gs.url; openGoogle.hidden = false; openGoogle.style.display = ''; 
    } else { openGoogle.hidden = true; openGoogle.style.display = 'none'; openGoogle.removeAttribute('href'); }
  }
  async function load() {
    if (busy || forbidden || document.hidden) return;
    busy = true;
    try { render((await global.zapeApi.json(base)).spreadsheet); }
    catch (error) {
      if (error.status === 403 || error.status === 401) { forbidden = true; card.hidden = true; card.style.display = 'none'; }
      else feedback.textContent = 'N\u00e3o foi poss\u00edvel consultar o status da planilha.';
    } finally { busy = false; }
  }
  sync.addEventListener('click', async function () {
    sync.disabled = true; feedback.textContent = 'Atualizando a c\u00f3pia local...';
    try {
      var result = await global.zapeApi.json(base + '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      render(result.spreadsheet);
      feedback.textContent = 'CSV atualizado. O Google Sheets, quando configurado, segue a fila autom\u00e1tica e os limites de tentativas.';
    } catch (error) { feedback.textContent = error.message; }
    finally { sync.disabled = false; }
  });
  download.addEventListener('click', async function () {
    download.disabled = true; feedback.textContent = 'Preparando o download...';
    try {
      var response = await global.zapeApi.request(base + '/download');
      if (!response.ok) {
        var errorBody = await response.json().catch(function () { return {}; });
        throw new Error(errorBody.error || 'N\u00e3o foi poss\u00edvel baixar a planilha.');
      }
      var blob = await response.blob();
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'contatos_' + global.zapeAppConfig.tenantId + '.csv';
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      feedback.textContent = 'Download preparado com todos os contatos desta conta.';
      load();
    } catch (error) { feedback.textContent = error.message; }
    finally { download.disabled = false; }
  });
  load();
  var timer = setInterval(load, 15000);
  global.addEventListener('pagehide', function () { clearInterval(timer); });
})(window);
