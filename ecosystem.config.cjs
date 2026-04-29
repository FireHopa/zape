module.exports = {
  apps: [
    {
      name: "bobia",
      script: "server.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        PORT: 3000
      },
      // Restart on crash
      autorestart: true,
      max_restarts: 20,
      restart_delay: 1000,
      // Logs
      time: true
    }
  ]
};
