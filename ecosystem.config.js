// pm2 process definition. Apply changes with: pm2 start ecosystem.config.js
//
// The app auto-restarts when backend code changes, so no manual restart is needed
// after an edit. index.html is deliberately NOT watched — it's served statically,
// so a browser refresh already picks up frontend changes without bouncing the
// process. data.db is NOT watched either: it is written on every transaction,
// session and login token, so watching it would put the server in a restart loop.
module.exports = {
  apps: [
    {
      name: 'portfolio-api',
      script: 'server.js',
      cwd: '/home/deploy/portfoliotracker',
      instances: 1,
      exec_mode: 'fork',

      // Only files that require a process restart to take effect.
      watch: ['server.js', 'schema.sqlite.sql', '.env'],
      watch_delay: 1000,
      ignore_watch: [
        'data.db',
        'data.db-wal',
        'data.db-shm',
        'data.db.backup*',
        'node_modules',
        'logs',
        '.git',
        'index.html',
        '*.log'
      ],

      autorestart: true,
      min_uptime: '10s',      // treat exits sooner than this as a failed start
      max_restarts: 10,       // stop flapping instead of looping forever
      restart_delay: 2000,
      max_memory_restart: '300M'
    }
  ]
};
