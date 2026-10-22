// Playwright (offline): drives the built app on localhost with the dry-run transport. No PayPal page
// is opened and no network beyond localhost is used. Build first (`corepack pnpm --filter
// @umsbx/web build`), then `corepack pnpm test:e2e`. Browsers come from PLAYWRIGHT_BROWSERS_PATH;
// nothing is downloaded here. All values below are test fixtures, not secrets.
import { scryptSync } from 'node:crypto';
import { defineConfig } from '@playwright/test';

const PORT = 3100;
export const E2E_PASSCODE = 'e2e passcode one';
const SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const hash = scryptSync(E2E_PASSCODE.normalize('NFKC'), SALT, 32, {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 256 * 16384 * 8,
}).toString('hex');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 45_000,
  use: { baseURL: `http://localhost:${PORT}`, trace: 'off' },
  projects: [
    { name: 'setup', testMatch: /setup\.spec\.ts$/ },
    { name: 'offline', testIgnore: /setup\.spec\.ts$/, dependencies: ['setup'] },
  ],
  webServer: {
    command: 'corepack pnpm exec next start -p 3100',
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      UMS_MODE: 'offline',
      UMS_SESSION_SECRET: 's'.repeat(40),
      UMS_APPROVAL_SECRET: 'a'.repeat(40),
      UMS_LINK_SECRET: 'l'.repeat(40),
      UMS_DEMO_PASSCODE_HASH: `scrypt$16384$8$1$${SALT.toString('hex')}$${hash}`,
      UMS_PUBLIC_ORIGIN: `http://localhost:${PORT}`,
      NODE_ENV: 'production',
    },
  },
});
