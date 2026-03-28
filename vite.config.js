import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    nodePolyfills({
      include: ['buffer', 'process', 'stream', 'util', 'events', 'path'],
    }),
    sveltekit(),
  ],
});
