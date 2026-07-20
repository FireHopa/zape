'use strict';

/**
 * @param {import('express').Application} app
 * @param {{ databaseRuntime: any, releaseMetadata?: Function }} options
 */
function registerHealthRoutes(app, options) {
  const { databaseRuntime, releaseMetadata } = options;
  app.get('/health', async (_req, res) => {
    try {
      const database = await databaseRuntime.health();
      return res.json({
        ok: true,
        persistenceMode: databaseRuntime.getState().config?.mode || 'json',
        database,
        release: typeof releaseMetadata === 'function' ? releaseMetadata() : undefined,
      });
    } catch (_) {
      return res.status(503).json({ ok: false, database: { ok: false } });
    }
  });
}

module.exports = { registerHealthRoutes };
