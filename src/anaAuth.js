const { makeBasicAuth } = require("./basicAuthFactory");

const anaAuth = makeBasicAuth({
  userEnv: "ANA_USER",
  passEnv: "ANA_PASS",
  realm: "Painel Ana Salomão",
});

module.exports = { anaAuth };
