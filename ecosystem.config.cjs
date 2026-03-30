module.exports = {
  apps: [
    {
      name: 'memescopesec',
      script: 'node',
      args: 'dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      kill_timeout: 10000,
      wait_ready: true,
      listen_timeout: 15000,
      exp_backoff_restart_delay: 100,
      max_restarts: 20,
      min_uptime: 10000,
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
