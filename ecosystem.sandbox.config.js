// PM2 config for the SANDBOX instance of JC-Market — runs ALONGSIDE production
// on the same droplet, as a separate process with its own port + DB.
//
// Started by scripts/setup-sandbox.sh from within the sandbox checkout
// (e.g. /var/www/jc-market-sandbox). The app reads that dir's own .env
// (PORT=3864, a sandbox-only JWT secret, BC dev, SlipOK mock), and writes to a
// SEPARATE data/stock-market.db — so the sandbox and production SQLite files
// never touch each other.
//
// Same single-instance fork rule as production: better-sqlite3 is a single
// writer, so never cluster this.
module.exports = {
  apps: [
    {
      name: 'jc-market-sandbox',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'development' },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
