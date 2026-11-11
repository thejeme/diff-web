import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  fullyParallel: true,
  workers: 3,
  use: { baseURL: 'http://127.0.0.1:4173', headless: true, viewport: { width: 1280, height: 900 } },
  webServer: { command: 'python3 -m http.server 4173 --bind 127.0.0.1', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
});
