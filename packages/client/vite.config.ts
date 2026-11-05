import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { SERVER_PORT } from '@skeleton/shared';

const COMMIT = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
})();

export default defineConfig({
  define: { __COMMIT__: JSON.stringify(COMMIT) },
  // The page reaches the game server on its own origin at /ws, in dev through this proxy, in prod through a reverse proxy.
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
      // Optional NPC voice proxy. When it is down, the client keeps the authored lines.
      '/npc': { target: 'http://127.0.0.1:8788', rewrite: (path) => path.replace(/^\/npc/, '') },
    },
  },
  worker: { format: 'es' },
  // three/webgpu alone is ~900 kB (~250 kB gzip).
  build: { target: 'es2022', sourcemap: 'hidden', chunkSizeWarningLimit: 1000 },
});
