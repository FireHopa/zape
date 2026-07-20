'use strict';

const path = require('path');

const appDir = process.env.ZAPE_APP_DIR || __dirname;
const logDir = process.env.ZAPE_LOG_DIR || '/var/log/zape';

module.exports = {
  apps: [
    {
      name: 'bobia',
      script: path.join(appDir, 'server.js'),
      cwd: appDir,
      exec_mode: 'fork',
      instances: 1,
      interpreter: process.execPath,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 3000,
        TRUST_PROXY_HOPS: 1,
        AUTH_TRUST_PROXY_HEADERS: 1,
        PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS: 1,
      },
      autorestart: true,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 2000,
      exp_backoff_restart_delay: 100,
      max_memory_restart: process.env.ZAPE_MAX_MEMORY || '1G',
      wait_ready: true,
      listen_timeout: 30000,
      kill_timeout: 90000,
      shutdown_with_message: true,
      merge_logs: true,
      time: true,
      out_file: path.join(logDir, 'app-out.log'),
      error_file: path.join(logDir, 'app-error.log'),
      source_map_support: true,
      watch: false,
    },
  ],
};
