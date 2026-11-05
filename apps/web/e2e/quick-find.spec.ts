// INT-OPS-B e2e (offline, dry run): quick-find in the operator shell. "/" opens it, a short ref finds the order,
// Enter goes to /ops/money/orders/<ref> (the page itself is checked in OPS-A's journeys). Two actions: "/" and
// Enter; typing the ref is not counted. The orders come from the journeys that ran before this file (the name
// sorts after journeys.spec.ts and purchase-reader-statement.spec.ts, and before refund.spec.ts and
// shell.spec.ts, so the authenticator codes still rise in order). The seller shell never has the search results.
import { createHmac } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { PASSCODE, TOTP_KEY_BYTES, buyerPage, payWithScenario } from './support';

const PUBLISHER_PASSCODE = 'e2e publisher passcode';

async function serverStep(page: Page): Promise<number> {
  const res = await page.request.get('/healthz');
  const ms = new Date(res.headers()['date'] ?? '').getTime();
  expect(Number.isFinite(ms)).toBe(true);
  return Math.floor(ms / 30_000);
}

function codeOf(step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', TOTP_KEY_BYTES).update(msg).digest();
  const o = (mac[19] ?? 0) & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function operatorWithCode(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const heading = page.getByRole('heading', { level: 1, name: /Operations/ });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const step = (await serverStep(page)) + 1;
    await page.goto('/signin?next=/ops');
    await page.getByLabel('Who are you testing as?').selectOption('operator');
    await page.getByLabel('Operator name').fill('vikram');
    await page.getByLabel('Demo passcode').fill(PASSCODE);
    await page.getByLabel('Authenticator code').fill(codeOf(step));
    await page.getByRole('button', { name: 'Sign in' }).click();
    const failed = page.getByText('That did not work.');
    await expect(heading.or(failed)).toBeVisible();
    if (await heading.isVisible()) return { ctx, page };
    await expect
      .poll(() => serverStep(page), { timeout: 45_000, intervals: [1000] })
      .toBeGreaterThanOrEqual(step);
  }
  throw new Error('operator sign-in with a code did not succeed');
}

test.describe.serial('quick-find', () => {
  let op: { ctx: BrowserContext; page: Page };
  let ref = '';
  test.beforeAll(async ({ browser }) => {
    op = await operatorWithCode(browser);
  });
  test.afterAll(async () => {
    await op.ctx.close();
  });

  test('the Transactions page lists orders, and the first row links to its order page', async ({
    browser,
  }) => {
    await op.page.goto('/ops/money/transactions');
    await expect(op.page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible();
    await expect(op.page.getByTestId('txn-status')).not.toHaveText('Loading transactions.');
    if ((await op.page.getByTestId('txn-ref').count()) === 0) {
      // A server that no earlier file used: make one order the way a buyer does.
      const buyer = await buyerPage(browser, 'b');
      await payWithScenario(buyer, { offer: 'tide-tables', scenario: 'happy' });
      await buyer.context().close();
      await op.page.reload();
    }
    const first = op.page.getByTestId('txn-ref').first();
    await expect(first).toBeVisible();
    const href = (await first.getAttribute('href')) ?? '';
    expect(href).toMatch(/^\/ops\/money\/orders\/.+/);
    ref = decodeURIComponent(href.split('/').pop() ?? '');
    expect(ref.length).toBeGreaterThan(6);
  });

  test('"/" then a short ref then Enter opens the order page', async () => {
    await op.page.goto('/ops');
    await op.page.keyboard.press('/');
    const field = op.page.getByTestId('shell-search-input');
    await expect(field).toBeFocused();
    await field.pressSequentially(ref.slice(-6));
    const results = op.page.getByRole('region', { name: 'Quick find results' });
    await expect(results.getByRole('heading', { name: 'Orders' })).toBeVisible();
    await field.press('Enter');
    await expect(op.page).toHaveURL(/\/ops\/money\/orders\/.+/);
    expect(decodeURIComponent(new URL(op.page.url()).pathname)).toMatch(
      new RegExp(`/ops/money/orders/.*${ref.slice(-6).replace(/[^A-Za-z0-9_-]/g, '.')}$`),
    );
  });

  test('typing nothing sends no request, and one character is not enough', async () => {
    const seen: string[] = [];
    op.page.on('request', (r) => {
      if (r.url().includes('/api/ops/find')) seen.push(r.url());
    });
    await op.page.goto('/ops');
    await op.page.keyboard.press('/');
    await op.page.getByTestId('shell-search-input').pressSequentially('a');
    await op.page.waitForTimeout(600);
    expect(seen).toEqual([]);
  });

  test('a seller sees the search slot without any quick-find results or request', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const seen: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/ops/find')) seen.push(r.url());
    });
    await page.goto('/signin?next=/publisher');
    await page.getByLabel('Who are you testing as?').selectOption('publisher-harbour-ledger');
    await page.getByLabel('Publisher passcode').fill(PUBLISHER_PASSCODE);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('publisher-name')).toBeVisible();
    await page.keyboard.press('/');
    await page.getByTestId('shell-search-input').pressSequentially('tide');
    await page.waitForTimeout(600);
    await expect(page.getByRole('region', { name: 'Quick find results' })).toHaveCount(0);
    expect(seen).toEqual([]);
    await ctx.close();
  });
});
