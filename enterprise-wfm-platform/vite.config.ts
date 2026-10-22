import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  const api = process.env.WFM_API || 'http://localhost:4000';   // the gateway
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: 3000,
      // The WFM gateway (Node) serves the REST API and the live WebSocket; the Python engine sits behind it.
      proxy: {
        '/api': api,
        '/health': api,
        '/ws': {target: api.replace('http', 'ws'), ws: true},
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
