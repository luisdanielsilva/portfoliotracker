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
      cwd: '/var/www/portfoliotracker',
      // Two workers on a two-core box. SQLite is fine with this *because* the
      // database is in WAL mode with a busy timeout: readers no longer block on a
      // writer, and a writer that finds the file locked waits its turn instead of
      // failing. Without both of those this would trade a queue for SQLITE_BUSY
      // errors. Do not raise this above the core count — these are CPU-bound
      // requests, and more workers than cores just adds context switching.
      //
      // Two consequences worth knowing: the rate limiters keep their counters in
      // each process's memory, so the effective limit is roughly doubled; and the
      // computed-view caches are per-process, so each warms up separately.
      instances: 2,
      exec_mode: 'cluster',

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
