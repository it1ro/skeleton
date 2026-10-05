import { defineConfig } from 'vite';
import { SERVER_PORT } from '@skeleton/shared';

export default defineConfig({
  // The page reaches the game server on its own origin at /ws, in dev through this proxy, in prod through a reverse proxy.
  server: { port: 5173, proxy: { '/ws': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true } } },
  worker: { format: 'es' },
  // three/webgpu alone is ~900 kB (~250 kB gzip).
  build: { target: 'es2022', sourcemap: 'hidden', chunkSizeWarningLimit: 1000 },
});
