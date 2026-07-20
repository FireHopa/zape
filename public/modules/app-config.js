'use strict';

(function bootstrapAppConfig(global) {
  var firstSegment =
    String(global.location.pathname || '')
      .split('/')
      .filter(Boolean)[0] || 'admin';
  var tenantId = /^[a-z0-9](?:[a-z0-9-]{0,31})$/i.test(firstSegment)
    ? firstSegment.toLowerCase()
    : 'admin';

  var labels = {
    admin: 'Admin',
    panel: 'Painel',
    regina: 'Regina',
    portugal: 'Portugal',
    felipe: 'Felipe',
    ana: 'Ana Salomão'
  };

  function titleFromSlug(slug) {
    return String(slug || '')
      .split('-')
      .filter(Boolean)
      .map(function (part) { return part.charAt(0).toUpperCase() + part.slice(1); })
      .join(' ') || 'Painel';
  }

  var injectedLabel = String((global.document.querySelector('meta[name="zape-tenant-label"]') || {}).content || '').trim();
  var label = injectedLabel || labels[tenantId] || titleFromSlug(tenantId);
  var supportedTenants = Object.keys(labels);
  if (!supportedTenants.includes(tenantId)) supportedTenants.push(tenantId);

  global.zapeAppConfig = Object.freeze({
    tenantId: tenantId,
    supportedTenants: Object.freeze(supportedTenants.slice()),
    active: Object.freeze({
      label: label,
      title: 'Casa do Ads • ' + label,
      apiBase: '/api/' + tenantId,
      csvBase: '/' + tenantId + '/leads.csv'
    }),
    cloudLanguage: tenantId === 'portugal' ? 'pt_PT' : 'pt_BR'
  });
})(window);
