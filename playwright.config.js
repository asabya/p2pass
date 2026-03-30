import { defineConfig, devices } from '@playwright/test';

const widgetPort = process.env.PLAYWRIGHT_PORT || '4173';
const widgetBaseURL = `http://127.0.0.1:${widgetPort}`;

export default defineConfig({
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? 'line' : [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results/',
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  projects: [
    {
      name: 'e2e',
      testDir: './e2e',
      testMatch: '**/*.spec.js',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:5173',
        permissions: ['clipboard-read', 'clipboard-write'],
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
      },
    },
    {
      name: 'widget',
      testDir: './e2e',
      testMatch: '**/*.e2e.test.js',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: widgetBaseURL,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
      },
    },
  ],
  webServer: [
    {
      command: 'node scripts/e2e-with-relay.mjs',
      url: 'http://localhost:5173/',
      timeout: 240_000,
      reuseExistingServer: process.env.PW_REUSE_SERVER === '1',
    },
    {
      command: `env VITE_BOOTSTRAP_PEERS= npm run dev:svelte -- --host 127.0.0.1 --port ${widgetPort}`,
      url: widgetBaseURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
