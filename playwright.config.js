import { defineConfig, devices } from '@playwright/test';

const playwrightPort = process.env.PLAYWRIGHT_PORT || '4173';
const baseURL = `http://127.0.0.1:${playwrightPort}`;

export default defineConfig({
	testDir: './tests',
	testMatch: '**/*.e2e.test.js',
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	timeout: 120 * 1000,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: process.env.CI ? 'line' : 'html',
	use: {
		baseURL,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome']
			}
		}
	],
	webServer: {
		command: `env VITE_BOOTSTRAP_PEERS= npm run dev:svelte -- --host 127.0.0.1 --port ${playwrightPort}`,
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120 * 1000
	}
});
