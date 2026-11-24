import { defineConfig } from '@playwright/test';

// Lancement : npm run test:e2e   (CHROMIUM_PATH peut pointer vers un Chromium déjà installé)
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3300',
    locale: 'fr-FR',
    timezoneId: 'Africa/Conakry',
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
  },
  webServer: {
    command: 'rm -rf .e2e-data && node e2e/prepare-db.mjs && npm run build && DATABASE_URL=${E2E_DATABASE_URL:-postgresql://postgres@127.0.0.1:5432/linklink_e2e} DATA_DIR=$PWD/.e2e-data PORT=3300 AUTH_FAIL_LIMIT_IP=100000 AUTH_FAIL_LIMIT_ACCOUNT=100000 AUTH_REQ_LIMIT_IP=1000000 npm start',
    url: 'http://localhost:3300/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
