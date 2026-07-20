'use strict';

const {
  ALLOWED_EXTRA_ROLES,
  isFelipePrimaryUsername,
  listFelipeUsers,
  createFelipeUser,
  updateFelipeUser,
  deleteFelipeUser,
} = require('../../felipeUserStore');

function sendError(res, error) {
  const status = Number(error?.statusCode) || 500;
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  return res.status(safeStatus).json({
    ok: false,
    code: error?.code || 'FELIPE_USER_MANAGEMENT_FAILED',
    error: error?.message || 'Não foi possível concluir a operação.',
  });
}

function requirePrimaryFelipe(req, res, next) {
  if (req.auth?.tenantId !== 'felipe' || !isFelipePrimaryUsername(req.auth?.username)) {
    return res.status(403).json({
      ok: false,
      code: 'FELIPE_USER_MANAGEMENT_FORBIDDEN',
      error: 'Somente o usuário principal do painel Felipe pode gerenciar usuários.',
    });
  }
  return next();
}

/**
 * @param {import('express').Application} app
 * @param {{ tenantId: string, authMiddleware: import('express').RequestHandler }} options
 */
function registerFelipeUserRoutes(app, options) {
  const { tenantId, authMiddleware } = options;
  if (tenantId !== 'felipe') return;
  const prefix = '/api/felipe/users';

  app.get(prefix, authMiddleware, requirePrimaryFelipe, (req, res) => {
    try {
      return res.json({
        ok: true,
        canManage: true,
        actor: req.auth.username,
        roles: ALLOWED_EXTRA_ROLES,
        items: listFelipeUsers(),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post(prefix, authMiddleware, requirePrimaryFelipe, async (req, res) => {
    try {
      const result = await createFelipeUser({
        actorUsername: req.auth.username,
        username: req.body?.username,
        password: req.body?.password,
        role: req.body?.role,
        enabled: req.body?.enabled !== false,
      });
      return res.status(201).json({ ok: true, user: result.user });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.put(`${prefix}/:userId`, authMiddleware, requirePrimaryFelipe, async (req, res) => {
    try {
      const result = await updateFelipeUser({
        actorUsername: req.auth.username,
        userId: req.params.userId,
        username: Object.prototype.hasOwnProperty.call(req.body || {}, 'username') ? req.body.username : undefined,
        password: Object.prototype.hasOwnProperty.call(req.body || {}, 'password') ? req.body.password : undefined,
        role: Object.prototype.hasOwnProperty.call(req.body || {}, 'role') ? req.body.role : undefined,
        enabled: Object.prototype.hasOwnProperty.call(req.body || {}, 'enabled') ? req.body.enabled : undefined,
      });
      return res.json({ ok: true, user: result.user });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.delete(`${prefix}/:userId`, authMiddleware, requirePrimaryFelipe, async (req, res) => {
    try {
      const result = await deleteFelipeUser({
        actorUsername: req.auth.username,
        userId: req.params.userId,
      });
      return res.json({ ok: true, user: result.user });
    } catch (error) {
      return sendError(res, error);
    }
  });
}

module.exports = { registerFelipeUserRoutes, requirePrimaryFelipe };
