import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dashboardHandler } from '../src/dashboard/server.js';

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'sloppy-reports',
    configureServer(server) {
      server.middlewares.use(dashboardHandler());
    },
  }],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
