const { makeBasicAuth } = require("./basicAuthFactory");

const portugalAuth = makeBasicAuth({
  userEnv: "PORTUGAL_USER",
  passEnv: "PORTUGAL_PASS",
  realm: "Painel Portugal",
});

module.exports = { portugalAuth };
