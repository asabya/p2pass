import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: __dirname,
	plugins: [
		tailwindcss(),
		nodePolyfills({
			include: ['buffer', 'process', 'stream', 'util', 'events', 'path']
		}),
		svelte()
	],
	worker: {
		format: 'es'
	},
	server: {
		headers: {
			'Content-Security-Policy': "script-src 'self' 'unsafe-eval' 'unsafe-inline'; worker-src 'self' blob:;"
		}
	}
});
