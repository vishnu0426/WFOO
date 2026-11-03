import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  const api = process.env.WFM_API || 'http://localhost:4000';
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 3001,
      proxy: {
        '/api': api,
        '/health': api,
      },
    },
    build: {
      outDir: path.resolve(__dirname, './dist'),
      emptyOutDir: true,
    },
  };
});
