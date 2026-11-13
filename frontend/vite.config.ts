import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [tailwindcss()],
  // The Express server mounts Vite in middleware mode during development,
  // so the app is always served from a single origin.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'landing/home': resolve(__dirname, 'landing/home.html'),
        'landing/login': resolve(__dirname, 'landing/login.html'),
        'landing/registration': resolve(__dirname, 'landing/registration.html'),
        'landing/forgot-password': resolve(__dirname, 'landing/forgot-password.html'),
        'landing/reset-password': resolve(__dirname, 'landing/reset-password.html'),
      },
    },
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
