import react from '@vitejs/plugin-react';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: __dirname,
	plugins: [
		react(),
		svelte(),
		nodePolyfills({
			include: ['buffer', 'process', 'stream', 'util', 'events', 'path']
		})
	],
	resolve: {
		alias: {
			'p2p-passkeys': path.resolve(__dirname, '../../src/lib')
		}
	},
	optimizeDeps: {
		exclude: ['@le-space/orbitdb-identity-provider-webauthn-did']
	},
	worker: {
		format: 'es'
	},
	server: {
		port: 5174,
		headers: {
			'Content-Security-Policy': "script-src 'self' 'unsafe-eval' 'unsafe-inline'; worker-src 'self' blob:;"
		}
	}
});
