import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Vite config for the RPMS SPA. The Express API runs on :3001;
// the dev server proxies /api/* so the browser only ever talks to :3000.
// See techstack.md §5.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  root: '.',
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
