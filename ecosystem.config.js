// PM2 process config for the JC-Market / TMS server on the DigitalOcean droplet.
//
//   pm2 start ecosystem.config.js      # first run
//   pm2 restart jc-market              # after a deploy (deploy.sh does this)
//   pm2 save && pm2 startup            # survive droplet reboots
//   pm2 logs jc-market                 # tail logs
//
// IMPORTANT: exec_mode is 'fork' with a single instance — NEVER cluster this
// app. better-sqlite3 is a single-writer embedded DB; multiple Node processes
// writing the same file would fight over the lock and can corrupt it. One
// process is correct here.
//
// The app reads its own .env via dotenv (PORT, JWT_SECRET, BC creds, ...), so
// secrets live in .env on the droplet — not in this file and not in git.
module.exports = {
  apps: [
    {
      name: 'jc-market',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
