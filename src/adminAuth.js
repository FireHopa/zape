const { makeBasicAuth } = require("./basicAuthFactory");

const adminAuth = makeBasicAuth({
  userEnv: "ADMIN_USER",
  passEnv: "ADMIN_PASS",
  realm: "Admin",
});

module.exports = { adminAuth };
