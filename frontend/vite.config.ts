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
    // When the frontend runs alone, forward the API to the Express server.
    // The normal `start.bat` flow mounts Vite in the server, so this is unused.
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
