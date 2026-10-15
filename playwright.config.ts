import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 45_000, workers: 1, retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: { command: 'npm run fixture', url: 'http://127.0.0.1:4173', reuseExistingServer: false },
  use: { trace: 'retain-on-failure' }
});
