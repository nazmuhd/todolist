import { createApp, frontendRoot } from './index.ts';
import { config } from './config.ts';

const app = createApp({ serveApp: config.isProduction });

if (!config.isProduction) {
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
  if (!config.hasSupabase) {
    console.warn('SUPABASE_URL / SUPABASE_ANON_KEY are not set — auth is disabled.');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => process.exit(0));
  });
}
