import { defineConfig, devices } from '@playwright/test';

const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices['iPhone 13'];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4177',
    trace: 'retain-on-failure',
    ...iPhone13,
    browserName: 'chromium',
  },
  webServer: {
    command: 'pnpm dev --host 127.0.0.1 --port 4177 --strictPort',
    url: 'http://127.0.0.1:4177',
    reuseExistingServer: true,
  },
});
