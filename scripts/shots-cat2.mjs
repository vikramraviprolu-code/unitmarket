// CAT-2 screenshots: /discover (popular requests and a proposal with collection lines) and the publisher home, each
// in light and dark, against the built offline app (`cd apps/web && corepack pnpm build` first).
//
//   node scripts/shots-cat2.mjs <output directory> [path of a Chromium executable]
//
// What it does: starts `next start` for apps/web with UMS_MODE=offline, a throwaway PGlite directory and the offline
// seed; stops it; adds 5 old buyers whose briefs ask for one term and gives two publishers that topic (straight
// into the throwaway database, nothing else); starts it again; signs in with the synthetic e2e passcodes; takes
// the shots at deviceScaleFactor 2; stops the server and removes the directory. Localhost only, nothing reaches
// PayPal. All secrets below are synthetic test values, as in apps/web/playwright.config.ts.
import { spawn } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../apps/web/node_modules/@playwright/test/index.mjs';
import { PGlite } from '../packages/db/node_modules/@electric-sql/pglite/dist/index.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/shots-cat2.mjs <output directory>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const PORT = 3107;
const hashOf = (passcode, saltHex) => {
  const salt = Buffer.from(saltHex, 'hex');
  return `scrypt$16384$8$1$${saltHex}$${scryptSync(passcode.normalize('NFKC'), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 256 * 16384 * 8 }).toString('hex')}`;
};
const BUYER_PASS = 'e2e passcode one';
const PUBLISHER_PASS = 'e2e publisher passcode';
const dir = mkdtempSync(join(tmpdir(), 'cat2-shots-'));
// Passed to the server as `env K=V ...`, so it inherits the rest of this process's environment untouched.
const settings = {
  NEXT_TELEMETRY_DISABLED: '1',
  UMS_MODE: 'offline',
  UMS_DB: 'pglite-disk',
  UMS_PGLITE_DIR: join(dir, 'db'),
  UMS_SESSION_SECRET: 's-synthetic-test-value-not-a-credential-s',
  UMS_APPROVAL_SECRET: 'a-synthetic-test-value-not-a-credential-a',
  UMS_LINK_SECRET: 'l-synthetic-test-value-not-a-credential-l',
  UMS_DEMO_PASSCODE_HASH: hashOf(BUYER_PASS, '00112233445566778899aabbccddeeff'),
  UMS_PUBLISHER_PASSCODE_HASH: hashOf(PUBLISHER_PASS, 'ffeeddccbbaa99887766554433221100'),
  UMS_JUDGE_PASSCODE_HASH: hashOf('e2e judge passcode', '0f1e2d3c4b5a69788796a5b4c3d2e1f0'),
  UMS_OPERATOR_TOTP_KEYS: 'vikram:GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  UMS_PUBLIC_ORIGIN: `http://localhost:${PORT}`,
  NODE_ENV: 'production',
};
const assignments = Object.entries(settings).map(([k, v]) => `${k}=${v}`);
// The server's own clock, read from a response header, so the seeded briefs fall in its 30 day window.
let serverNow = null;

let server = null;
function start() {
  server = spawn(
    'env',
    [
      ...assignments,
      'corepack',
      'pnpm',
      'exec',
      'next',
      'start',
      '-H',
      '127.0.0.1',
      '-p',
      String(PORT),
    ],
    { cwd: join(root, 'apps/web'), stdio: 'ignore', detached: true },
  );
}
async function stop() {
  if (server === null) return;
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 2500));
  server = null;
}
async function waitUp(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  for (let i = 0; i < 90; i++) {
    try {
      const r = await page.goto(`http://localhost:${PORT}/healthz`, { timeout: 3000 });
      if (r && r.ok()) {
        serverNow = new Date(r.headers()['date']);
        await ctx.close();
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('the app did not start');
}

const TERM = 'tide tables';
// The page cross-fades between routes: wait for it to settle, and pick the dark look (the skin "Deep Harbour").
async function settle(page, scheme) {
  if (scheme === 'dark') await page.getByLabel('Deep Harbour').check();
  await page.waitForLoadState('networkidle');
  await new Promise((r) => setTimeout(r, 2000));
}
async function seed() {
  const pg = new PGlite(settings.UMS_PGLITE_DIR);
  await pg.waitReady;
  const old = '2026-01-01T00:00:00.000Z';
  const asked = new Date(serverNow.getTime() - 3 * 86_400_000).toISOString();
  for (let i = 1; i <= 5; i++) {
    await pg.query(
      `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ($1,$2,$3,'US',$4::timestamptz,$4::timestamptz)`,
      [`buy_shot${i}`, `Shot buyer ${i}`, `sub-shot-${i}`, old],
    );
    await pg.query(
      `INSERT INTO briefs (id, buyer_id, raw_text, structured, version, confirmed_at, created_at, updated_at)
       VALUES ($1,$2,'a request',$3::jsonb,'scripted-v1',NULL,$4::timestamptz,$4::timestamptz)`,
      [
        `brf_shot${i}`,
        `buy_shot${i}`,
        JSON.stringify({ need: TERM, ceiling: null, option: null, language: null, terms: [TERM] }),
        asked,
      ],
    );
  }
  // Two publishers get the topic on one authorised offer each, so the term can surface.
  await pg.query(
    `UPDATE articles SET topics = topics || ARRAY[$1::text]
      WHERE id IN (SELECT DISTINCT ON (o.publisher_id) o.article_id FROM offers o
                    WHERE o.status = 'authorised' AND o.superseded_by IS NULL ORDER BY o.publisher_id, o.id)`,
    [TERM],
  );
  await pg.close();
}

// The Chromium of apps/web's Playwright when installed; otherwise the executable named by the optional second
// argument (for example a preinstalled Chromium of another Playwright version).
async function launch() {
  const executablePath = process.argv[3];
  return chromium.launch({
    args: ['--no-sandbox'],
    ...(executablePath ? { executablePath: resolve(executablePath) } : {}),
  });
}
const browser = await launch();
let failed = false;
try {
  start();
  await waitUp(browser);
  await stop();
  await seed();
  start();
  await waitUp(browser);
  const base = `http://localhost:${PORT}`;
  for (const scheme of ['light', 'dark']) {
    const view = {
      colorScheme: scheme,
      viewport: { width: 1100, height: 900 },
      deviceScaleFactor: 2,
    };
    const ctx = await browser.newContext(view);
    const page = await ctx.newPage();
    // Buyer: popular requests, tap a chip, find articles.
    await page.goto(`${base}/signin`);
    await page.getByLabel('Who are you testing as?').selectOption('buyer-a');
    await page.getByLabel('Demo passcode').fill(BUYER_PASS);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('link', { name: 'My library' }).waitFor();
    await page.goto(`${base}/discover`);
    await page.getByTestId('popular-requests').waitFor();
    await settle(page, scheme);
    await page.screenshot({ path: join(out, `cat2-discover-chips-${scheme}.png`), fullPage: true });
    await page.getByRole('button', { name: TERM }).click();
    await page.getByRole('button', { name: 'Find articles' }).click();
    await page.getByText('Articles that fit').waitFor();
    await settle(page, scheme);
    await page.screenshot({
      path: join(out, `cat2-discover-proposal-${scheme}.png`),
      fullPage: true,
    });
    await ctx.close();
    // Publisher: the home with "What buyers ask for".
    const pctx = await browser.newContext(view);
    const ppage = await pctx.newPage();
    await ppage.goto(`${base}/signin?next=/publisher`);
    await ppage.getByLabel('Who are you testing as?').selectOption('publisher-harbour-ledger');
    await ppage.getByLabel('Publisher passcode').fill(PUBLISHER_PASS);
    await ppage.getByRole('button', { name: 'Sign in' }).click();
    await ppage.getByTestId('publisher-demand').waitFor();
    await settle(ppage, scheme);
    await ppage.screenshot({
      path: join(out, `cat2-publisher-demand-${scheme}.png`),
      fullPage: true,
    });
    await pctx.close();
  }
} catch (e) {
  failed = true;
  console.error(String(e && e.stack ? e.stack : e));
} finally {
  await browser.close();
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
