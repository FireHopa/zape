const { makeBasicAuth } = require("./basicAuthFactory");

const panelAuth = makeBasicAuth({
  userEnv: "PANEL_USER",
  passEnv: "PANEL_PASS",
  realm: "Panel",
});

module.exports = { panelAuth };
