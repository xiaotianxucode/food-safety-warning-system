import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3101', headless: true },
  webServer: {
    command: 'npx tsx tests/e2e/server.ts',
    url: 'http://127.0.0.1:3101/api/health',
    reuseExistingServer: false,
    timeout: 30000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
