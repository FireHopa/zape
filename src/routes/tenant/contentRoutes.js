'use strict';

/**
 * @param {import('express').Application} app
 * @param {{
 *  tenantId: string,
 *  authMiddleware: import('express').RequestHandler,
 *  listTags: Function,
 *  upsertTag: Function,
 *  deleteTag: Function,
 *  removeTagFromAllLeads: Function,
 *  setLeadTags: Function,
 *  buildBulkLeadTagsHandler: Function,
 *  getTemplate: Function,
 *  updateTemplateSafe: Function
 * }} options
 */
function registerContentRoutes(app, options) {
  const {
    tenantId,
    authMiddleware,
    listTags,
    upsertTag,
    deleteTag,
    removeTagFromAllLeads,
    setLeadTags,
    buildBulkLeadTagsHandler,
    getTemplate,
    updateTemplateSafe,
  } = options;
  const apiPrefix = `/api/${tenantId}`;

  app.get(`${apiPrefix}/tags`, authMiddleware, (_req, res) => {
    return res.json({ ok: true, items: listTags(tenantId) });
  });

  app.post(`${apiPrefix}/tags`, authMiddleware, (req, res) => {
    try {
      const tag = upsertTag(tenantId, {
        id: req.body?.id || null,
        name: req.body?.name,
        color: req.body?.color,
      });
      return res.json({ ok: true, item: tag });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.delete(`${apiPrefix}/tags/:id`, authMiddleware, (req, res) => {
    try {
      deleteTag(tenantId, req.params.id);
      removeTagFromAllLeads(tenantId, req.params.id);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post(`${apiPrefix}/leads/:id/tags`, authMiddleware, (req, res) => {
    try {
      const allowed = new Set(listTags(tenantId).map((tag) => tag.id));
      const tagIds = (Array.isArray(req.body?.tagIds) ? req.body.tagIds : [])
        .map((value) => String(value).trim())
        .filter((value) => allowed.has(value));
      return res.json({ ok: true, ...setLeadTags(tenantId, req.params.id, tagIds) });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post(`${apiPrefix}/leads/bulk-tags`, authMiddleware, buildBulkLeadTagsHandler(tenantId));

  app.get(`${apiPrefix}/message-template`, authMiddleware, (_req, res) => {
    return res.json({ ok: true, ...getTemplate(tenantId) });
  });

  app.post(`${apiPrefix}/message-template`, authMiddleware, (req, res) => {
    try {
      return res.json({ ok: true, ...updateTemplateSafe(tenantId, req.body?.text) });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { registerContentRoutes };
