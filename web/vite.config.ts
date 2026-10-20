import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// Numéro affiché dans l'application : permet de vérifier d'un coup d'œil quelle version tourne.
let commit = 'local';
try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'local'; } catch { /* pas de dépôt git */ }

// En développement, les appels /api et /ws sont renvoyés vers le serveur (port 3000).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(`v1.1 · ${commit}`) },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
