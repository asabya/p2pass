import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	timeout: 180_000,
	expect: { timeout: 30_000 },

	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				permissions: ['clipboard-read', 'clipboard-write']
			}
		}
	],

	reporter: [['list'], ['html', { open: 'never' }]],
	outputDir: 'test-results/',
	retries: process.env.CI ? 1 : 0,
	workers: 1,

	webServer: {
		command: 'node scripts/e2e-with-relay.mjs',
		url: 'http://localhost:5173/',
		timeout: 240_000,
		// If true, Playwright skips starting this command when port 5173 is free — you get no relay,
		// no VITE_BOOTSTRAP_PEERS, and no [e2e] logs. Opt-in: PW_REUSE_SERVER=1 npm run test:e2e
		reuseExistingServer: process.env.PW_REUSE_SERVER === '1'
	},

	use: {
		baseURL: 'http://localhost:5173',
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure',
		video: 'retain-on-failure'
	}
});
