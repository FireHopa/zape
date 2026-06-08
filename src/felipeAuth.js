const { makeBasicAuth } = require("./basicAuthFactory");

const felipeAuth = makeBasicAuth({
  userEnv: "FELIPE_USER",
  passEnv: "FELIPE_PASS",
  realm: "Painel Felipe",
});

module.exports = { felipeAuth };
