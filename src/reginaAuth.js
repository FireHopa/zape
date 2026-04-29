const { makeBasicAuth } = require("./basicAuthFactory");

const reginaAuth = makeBasicAuth({
  userEnv: "REGINA_USER",
  passEnv: "REGINA_PASS",
  realm: "Painel da Regina",
});

module.exports = { reginaAuth };