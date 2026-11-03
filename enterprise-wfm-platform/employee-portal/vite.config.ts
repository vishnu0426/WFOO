import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The employee portal talks to the same gateway as the admin web app and the mobile app -- same /api/v1, same
// bearer-token auth, same self-service endpoints. It just runs on its own port so it can be deployed separately.
export default defineConfig(() => {
  const api = process.env.WFM_API || 'http://localhost:4000';
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 3002,
      proxy: { '/api': api, '/health': api },
    },
  };
});
