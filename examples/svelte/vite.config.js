import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: process.env.BASE_URL || '/',
  root: __dirname,
  // Load `.env*` from repo root so `VITE_BOOTSTRAP_PEERS` / relay URL work when not using
  // `scripts/e2e-with-relay.mjs` (e.g. `npm run dev:example` with a local relay).
  envDir: path.resolve(__dirname, '../..'),
  plugins: [
    tailwindcss(),
    nodePolyfills({
      include: ['buffer', 'process', 'stream', 'util', 'events', 'path'],
    }),
    svelte(),
  ],
  resolve: {
    alias: {
      p2pass: path.resolve(__dirname, '../../src/lib'),
    },
  },
  optimizeDeps: {
    exclude: ['@le-space/orbitdb-identity-provider-webauthn-did'],
  },
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      'Content-Security-Policy':
        "script-src 'self' 'unsafe-eval' 'unsafe-inline'; worker-src 'self' blob:;",
    },
  },
});
