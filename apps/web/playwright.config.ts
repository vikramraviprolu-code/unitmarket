// Playwright (offline): drives the built app on localhost with the dry-run transport. No PayPal page
// is opened and no network beyond localhost is used. Build first (`corepack pnpm --filter
// @umsbx/web build`), then `corepack pnpm test:e2e`. Browsers come from PLAYWRIGHT_BROWSERS_PATH;
// nothing is downloaded here. All values below are test fixtures, not secrets.
import { scryptSync } from 'node:crypto';
import { defineConfig } from '@playwright/test';

const PORT = 3100;
export const E2E_PASSCODE = 'e2e passcode one';
// Synthetic test passcodes, one salt each, hashed the way the demo one is. Test fixtures, not secrets.
// The hashes must differ from each other (the config refuses equal hashes).
export const E2E_PUBLISHER_PASSCODE = 'e2e publisher passcode';
export const E2E_JUDGE_PASSCODE = 'e2e judge passcode';
const SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const PUBLISHER_SALT = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex');
const JUDGE_SALT = Buffer.from('0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex');
const hashOf = (passcode: string, salt: Buffer): string =>
  `scrypt$16384$8$1$${salt.toString('hex')}$${scryptSync(passcode.normalize('NFKC'), salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 256 * 16384 * 8,
  }).toString('hex')}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // GATE35 D11: screenshots and traces stay in an ignored directory; no tracked file is rewritten.
  outputDir: './test-results',
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
      UMS_SESSION_SECRET: 's-synthetic-test-value-not-a-credential-s',
      UMS_APPROVAL_SECRET: 'a-synthetic-test-value-not-a-credential-a',
      UMS_LINK_SECRET: 'l-synthetic-test-value-not-a-credential-l',
      UMS_DEMO_PASSCODE_HASH: hashOf(E2E_PASSCODE, SALT),
      UMS_PUBLISHER_PASSCODE_HASH: hashOf(E2E_PUBLISHER_PASSCODE, PUBLISHER_SALT),
      UMS_JUDGE_PASSCODE_HASH: hashOf(E2E_JUDGE_PASSCODE, JUDGE_SALT),
      // CO-6: the RFC 6238 test key (ASCII "12345678901234567890") for the operator "vikram". A public
      // test value, not a credential.
      UMS_OPERATOR_TOTP_KEYS: 'vikram:GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      UMS_PUBLIC_ORIGIN: `http://localhost:${PORT}`,
      NODE_ENV: 'production',
    },
  },
});
