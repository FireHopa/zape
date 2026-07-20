'use strict';

(function bootstrapApiClient(global) {
  async function request(url, options) {
    var merged = Object.assign(
      {
        credentials: 'same-origin',
        cache: 'no-store',
      },
      options || {}
    );
    merged.headers = Object.assign({ Accept: 'application/json' }, merged.headers || {});
    return global.fetch(url, merged);
  }

  async function json(url, options) {
    var response = await request(url, options);
    var payload = await response.json().catch(function () {
      return null;
    });
    if (!response.ok || !payload || payload.ok === false) {
      var error = new Error(
        (payload && (payload.error || payload.message)) || 'Falha HTTP ' + response.status
      );
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  global.zapeApi = Object.freeze({ request: request, json: json });
})(window);
