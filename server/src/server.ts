import { createApp, frontendRoot } from './index.ts';
import { config } from './config.ts';
import { migrate } from './db/migrate.ts';
import { startReminderWorker } from './services/reminders.ts';
import { startBackupWorker } from './services/backups.ts';

// The API is useless without its tables; apply pending migrations on boot.
await migrate();

let app;
if (!config.isProduction) {
  // Vite in middleware mode: one process, one port, hot reloading.
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: frontendRoot,
    server: { middlewareMode: true },
    appType: 'custom',
  });
  app = createApp({ serveApp: false, vite });
  // Vite asset/module/HMR middleware (after app routes that need transformIndexHtml).
  app.use(vite.middlewares);
} else {
  app = createApp({ serveApp: true });
}

const server = app.listen(config.PORT, () => {
  console.log(`todoist-clone-server listening on http://localhost:${config.PORT}`);
  if (!config.isProduction) console.log('  development mode: Vite middleware (HMR enabled)');
  console.log(`  database: ${config.DATABASE_PATH}`);
  console.log(`  automatic backups: every ${config.BACKUP_INTERVAL_MINUTES} min, keeping ${config.BACKUP_KEEP}`);
  if (!config.hasPush) console.log('  push notifications disabled (no VAPID keys)');
  else console.log('  push notifications enabled; reminder worker running');
  startReminderWorker();
  startBackupWorker();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => process.exit(0));
  });
}
