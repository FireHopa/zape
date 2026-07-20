'use strict';

(function bootstrapZapeSecurity(global) {
  var purifier = global.DOMPurify;
  if (!purifier) throw new Error('DOMPurify não foi carregado.');

  var sanitizeConfig = {
    ALLOW_DATA_ATTR: true,
    ALLOW_ARIA_ATTR: true,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'base', 'meta', 'link', 'form'],
    FORBID_ATTR: ['srcdoc'],
    RETURN_TRUSTED_TYPE: false
  };

  function sanitizeHtml(value) {
    return purifier.sanitize(String(value == null ? '' : value), sanitizeConfig);
  }

  function normalizeUrl(value, options) {
    options = options || {};
    var raw = String(value == null ? '' : value).trim();
    if (!raw || /[\u0000-\u001F\u007F]/.test(raw)) return '';
    if (options.allowBlob && raw.indexOf('blob:') === 0) return raw;
    if (options.allowDataImage && /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(raw)) return raw;
    if (options.allowDataAudio && /^data:audio\/(?:webm|ogg|mpeg|mp4|wav);base64,[a-z0-9+/=\s]+$/i.test(raw)) return raw;
    var url;
    try { url = new URL(raw, global.location.origin); }
    catch (_) { return ''; }
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (options.sameOrigin !== false && url.origin !== global.location.origin) return '';
    if (Array.isArray(options.allowedOrigins) && options.allowedOrigins.length && !options.allowedOrigins.includes(url.origin)) return '';
    return url.href;
  }

  function setElementUrl(element, attribute, value, options) {
    if (!element) return false;
    var safe = normalizeUrl(value, options);
    if (!safe) {
      element.removeAttribute(attribute);
      return false;
    }
    element.setAttribute(attribute, safe);
    return true;
  }

  function readCookie(name) {
    var prefix = encodeURIComponent(name) + '=';
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].trim();
      if (part.indexOf(prefix) !== 0) continue;
      try { return decodeURIComponent(part.slice(prefix.length)); }
      catch (_) { return part.slice(prefix.length); }
    }
    return '';
  }

  function isUnsafeMethod(method) {
    return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
  }

  var allowedScriptOrigins = ['https://connect.facebook.net', 'https://cdn.jsdelivr.net'];
  if (global.trustedTypes) {
    try {
      global.trustedTypes.createPolicy('default', {
        createHTML: sanitizeHtml,
        createScript: function () { return ''; },
        createScriptURL: function (value) {
          var safe = normalizeUrl(value, { sameOrigin: false, allowedOrigins: allowedScriptOrigins.concat([global.location.origin]) });
          if (!safe) throw new TypeError('URL de script não autorizada.');
          return safe;
        }
      });
    } catch (error) {
      if (!/already exists/i.test(String(error && error.message || error))) throw error;
    }
  } else {
    var descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (descriptor && descriptor.set && descriptor.get) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set: function (value) { descriptor.set.call(this, sanitizeHtml(value)); }
      });
    }
    var originalInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    if (originalInsertAdjacentHTML) {
      Element.prototype.insertAdjacentHTML = function (position, value) {
        return originalInsertAdjacentHTML.call(this, position, sanitizeHtml(value));
      };
    }
  }

  var nativeFetch = global.fetch.bind(global);
  global.fetch = function secureFetch(input, init) {
    var options = Object.assign({}, init || {});
    var requestUrl = input && typeof input === 'object' && input.url ? input.url : input;
    var url;
    try { url = new URL(String(requestUrl || ''), global.location.origin); }
    catch (_) { return Promise.reject(new TypeError('URL de requisição inválida.')); }
    if (!['http:', 'https:'].includes(url.protocol)) return Promise.reject(new TypeError('Protocolo de requisição bloqueado.'));

    var method = String(options.method || (input && input.method) || 'GET').toUpperCase();
    if (url.origin === global.location.origin && isUnsafeMethod(method)) {
      var headers = new Headers(options.headers || (input && input.headers) || {});
      var token = readCookie('zape_csrf');
      if (token) headers.set('X-Zape-CSRF-Token', token);
      headers.set('X-Requested-With', 'Zape');
      options.headers = headers;
      if (!options.credentials) options.credentials = 'same-origin';
    }
    return nativeFetch(input, options);
  };

  global.zapeSecurity = Object.freeze({
    sanitizeHtml: sanitizeHtml,
    normalizeUrl: normalizeUrl,
    setElementUrl: setElementUrl,
    readCookie: readCookie
  });
})(window);
