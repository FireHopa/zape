'use strict';

(function initLogin() {
  var qs = new URLSearchParams(location.search);
  var tenantEl = document.getElementById('tenant');
  var userEl = document.getElementById('username');
  var errEl = document.getElementById('err');
  var requestedTenant = String(qs.get('tenant') || '').toLowerCase();
  var available = Array.prototype.map.call(tenantEl.options || [], function (option) { return option.value; });
  var tenant = available.includes(requestedTenant) ? requestedTenant : (available[0] || 'admin');
  tenantEl.value = tenant;
  userEl.value = localStorage.getItem('zape_login_user_' + tenantEl.value) || '';

  tenantEl.addEventListener('change', function () {
    userEl.value = localStorage.getItem('zape_login_user_' + tenantEl.value) || '';
  });

  function showError(message) {
    errEl.textContent = message || 'Não foi possível autenticar.';
    errEl.style.display = 'block';
  }

  document.getElementById('form').addEventListener('submit', async function (event) {
    event.preventDefault();
    errEl.style.display = 'none';
    var btn = document.getElementById('btn');
    btn.disabled = true;
    btn.textContent = 'Entrando...';
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    try {
      var body = {
        tenant: tenantEl.value,
        username: userEl.value.trim(),
        password: document.getElementById('password').value.trim(),
        remember: document.getElementById('remember').checked
      };
      var response = await fetch('/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || !data.ok) throw new Error(data.error || 'Não foi possível autenticar.');
      localStorage.setItem('zape_login_user_' + tenantEl.value, body.username);
      var target = typeof data.next === 'string' && data.next.startsWith('/') && !data.next.startsWith('//')
        ? data.next
        : ('/' + tenantEl.value);
      location.assign(target);
    } catch (error) {
      showError(error && error.name === 'AbortError'
        ? 'O servidor não respondeu ao login.'
        : (error.message || 'Não foi possível autenticar.'));
    } finally {
      clearTimeout(timer);
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  });
})();
