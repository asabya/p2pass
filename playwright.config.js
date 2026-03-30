import { defineConfig, devices } from '@playwright/test';

const widgetPort = process.env.PLAYWRIGHT_PORT || '4173';
const widgetBaseURL = `http://127.0.0.1:${widgetPort}`;

/** In GitHub Actions, use `github` for annotations plus `line` so each test is printed. Passing only `--reporter=github` on the CLI replaces config and hides per-test progress. */
const reporter = process.env.GITHUB_ACTIONS
  ? [['github'], ['line']]
  : process.env.CI
    ? 'line'
    : [['list'], ['html', { open: 'never' }]];

/** Relay/Vite are very chatty; suppress in CI unless PW_WEBSERVER_LOGS=1 for debugging. */
const webServerStdio =
  process.env.CI && process.env.PW_WEBSERVER_LOGS !== '1' ? 'ignore' : 'inherit';

export default defineConfig({
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter,
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
      stdout: webServerStdio,
      stderr: webServerStdio,
    },
    {
      command: `env VITE_BOOTSTRAP_PEERS= npm run dev:svelte -- --host 127.0.0.1 --port ${widgetPort}`,
      url: widgetBaseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: webServerStdio,
      stderr: webServerStdio,
    },
  ],
});
