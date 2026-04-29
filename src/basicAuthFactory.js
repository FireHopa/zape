const auth = require("basic-auth");

/**
 * Basic Auth middleware.
 * If env vars are missing, it allows access (dev/local).
 */
function makeBasicAuth({ userEnv, passEnv, realm }) {
  return function basicAuthMiddleware(req, res, next) {
    const user = process.env[userEnv];
    const pass = process.env[passEnv];

    if (!user || !pass) return next();

    const creds = auth(req);
    if (!creds || creds.name !== user || creds.pass !== pass) {
      res.set("WWW-Authenticate", `Basic realm="${realm || "Protected"}"`);
      return res.status(401).send("Unauthorized");
    }
    next();
  };
}

module.exports = { makeBasicAuth };
