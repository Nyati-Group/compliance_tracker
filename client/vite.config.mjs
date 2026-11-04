import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const api = `http://127.0.0.1:${process.env.PORT || 8000}`;

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: { alias: { '@shared': path.join(here, '..', 'shared') } },
  server: {
    port: 5173,
    fs: { allow: [path.join(here, '..')] },
    proxy: Object.fromEntries(['/api', '/auth', '/files', '/data', '/images', '/healthz'].map((p) => [p, { target: api, changeOrigin: false }]))
  },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    rollupOptions: { input: { index: path.join(here, 'index.html'), login: path.join(here, 'login.html') } }
  }
});
