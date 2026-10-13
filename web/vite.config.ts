import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En développement, les appels /api et /ws sont renvoyés vers le serveur (port 3000).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
