import { defineConfig } from 'vite';

export default defineConfig({
  // The Express server mounts Vite in middleware mode during development,
  // so the app is always served from a single origin.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
