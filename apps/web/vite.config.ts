import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://127.0.0.1:4310';
const proxy = {
  '/api': { target: api, changeOrigin: false },
  '/ws': { target: api.replace('http', 'ws'), ws: true, changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    sourcemap: false,
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') || id.includes('node_modules/zustand')) return 'vendor';
          if (id.includes('react-markdown') || id.includes('remark') || id.includes('micromark') || id.includes('mdast') || id.includes('unified') || id.includes('hast')) return 'markdown';
          return undefined;
        },
      },
    },
  },
});
