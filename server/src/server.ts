import { createApp, frontendRoot } from './index.ts';
import { config } from './config.ts';
import { migrate } from './db/migrate.ts';
import { startReminderWorker } from './services/reminders.ts';
import { startBackupWorker } from './services/backups.ts';

const app = createApp({ serveApp: config.isProduction });

// The API is useless without its tables; apply pending migrations on boot.
await migrate();

if (!config.isProduction) {
  // Serve the app at /app/v1 so / can be the landing page.
  const { resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = resolve(fileURLToPath(import.meta.url), '..');
  const frontendRoot = resolve(__dirname, '../..', 'frontend');
  app.get('/app/v1/*', (_req, res) => res.sendFile(resolve(frontendRoot, 'index.html')));
  app.get('/app/v1', (_req, res) => res.sendFile(resolve(frontendRoot, 'index.html')));

  // Vite in middleware mode: one process, one port, hot reloading.
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: frontendRoot,
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
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
