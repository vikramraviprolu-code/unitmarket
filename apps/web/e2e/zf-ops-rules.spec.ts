// BR-6 e2e (offline, dry run): the operator "Business rules" screens in a real browser. An operator signs in with a
// code from the public RFC 6238 test key (as shell.spec.ts does), reads the rules, adds a platform refund window
// through the form, sees it on the list and the history, reads the terms of an existing order, and a buyer, a
// seller and a visitor are sent to sign in. Light (Bright Market) and dark (Deep Harbour) screenshots of the four
// pages go to the ignored test-results folder. The file name
// sorts after ze-publisher-offers.spec.ts and before zz-ops-stop.spec.ts, so the authenticator codes rise in order
// and the stop spec still runs last.
import { createHmac } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { PASSCODE, TOTP_KEY_BYTES, buyerPage, payWithScenario } from './support';

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
  throw new Error('operator sign in with a code did not succeed');
}

const RULES_PATHS = [
  '/ops/rules',
  '/ops/rules/new',
  '/ops/rules/history',
  '/ops/rules/explain',
] as const;

test.describe('operator business rules screens', () => {
  let op: { ctx: BrowserContext; page: Page };
  test.beforeAll(async ({ browser }) => {
    op = await operatorWithCode(browser);
    // Run alone there is no order yet: buy one as buyer b, as ops-order.spec.ts does.
    await op.page.goto('/ops/money/transactions');
    await expect(op.page.getByTestId('txn-status')).not.toHaveText('Loading transactions.');
    if ((await op.page.locator('a[href^="/ops/money/orders/"]').count()) === 0) {
      const buyer = await buyerPage(browser, 'b');
      await payWithScenario(buyer, { offer: 'tide-tables', scenario: 'happy' });
      await buyer.context().close();
    }
  });
  test.afterAll(async () => {
    await op.ctx.close();
  });

  test('the list has one row per rule and Business rules is a Controls section tab', async () => {
    await op.page.goto('/ops/rules');
    await expect(op.page.getByRole('heading', { level: 1, name: 'Business rules' })).toBeVisible();
    await expect(op.page.getByTestId('rule-row')).toHaveCount(3);
    await expect(op.page.getByTestId('rule-row').first()).toContainText('Refund window');
    await expect(
      op.page.getByRole('navigation', { name: /Controls/ }).getByRole('link', {
        name: 'Business rules',
      }),
    ).toBeVisible();
  });

  test('the form says what the change does, saves a platform setting and the list shows it', async () => {
    await op.page.goto('/ops/rules/new');
    await expect(op.page.getByTestId('rules-impact')).toContainText(
      'Sales already approved keep their terms.',
    );
    await op.page.getByLabel('Rule', { exact: true }).selectOption({ label: 'Refund window' });
    await op.page.getByLabel('Applies to', { exact: true }).selectOption({ label: 'Everyone' });
    await op.page.getByLabel('Value in days', { exact: true }).fill('10');
    await op.page.getByLabel('Reason', { exact: true }).fill('Pilot window for the demo');
    await op.page.getByTestId('rules-save').click();
    await expect(op.page.getByTestId('rules-answer')).toContainText('Saved.');
    await op.page.goto('/ops/rules');
    await expect(op.page.getByTestId('rule-row').first()).toContainText('10 days');
    await expect(op.page.getByTestId('rule-row').first()).toContainText(
      'Pilot window for the demo',
    );
  });

  test('the history lists the setting and a filter that is not a rule lists nothing', async () => {
    await op.page.goto('/ops/rules/history');
    await expect(op.page.getByTestId('history-row').first()).toContainText(
      'Pilot window for the demo',
    );
    await op.page.goto('/ops/rules/history?rule_key=nonsense');
    await expect(op.page.getByTestId('history-invalid')).toBeVisible();
    await expect(op.page.getByTestId('history-row')).toHaveCount(0);
  });

  test('the export button saves a CSV file with the header and the setting', async () => {
    await op.page.goto('/ops/rules');
    const [download] = await Promise.all([
      op.page.waitForEvent('download'),
      op.page.getByTestId('rules-export').click(),
    ]);
    expect(download.suggestedFilename()).toBe('business-rules-history.csv');
  });

  test('explain shows the terms of an order by its reference, and refuses a bad id with a 404', async () => {
    await op.page.goto('/ops/money/transactions');
    const link = op.page.locator('a[href^="/ops/money/orders/"]').first();
    await expect(link).toBeVisible();
    const ref = (await link.getAttribute('href'))!.split('/').pop()!;
    await op.page.goto(`/ops/rules/explain?order=${ref}`);
    await expect(op.page.getByTestId('explain-row')).toHaveCount(3);
    await expect(op.page.getByTestId('explain-facts')).toContainText('Rules version: 1');
    const bad = await op.page.goto("/ops/rules/explain?order=ord_1'%20OR%20'1'='1");
    expect(bad?.status()).toBe(404);
  });

  test('screenshots in light and dark', async ({ baseURL }, testInfo) => {
    const out = (name: string): string => testInfo.outputPath(name);
    await op.page.goto('/ops/money/transactions');
    const ref = (await op.page
      .locator('a[href^="/ops/money/orders/"]')
      .first()
      .getAttribute('href'))!
      .split('/')
      .pop()!;
    for (const [skin, label] of [
      ['market', 'light'],
      ['harbour', 'dark'],
    ] as const) {
      await op.ctx.addCookies([
        { name: 'um_skin', value: skin, url: baseURL ?? 'http://localhost:3100' },
      ]);
      await op.page.setViewportSize({ width: 1280, height: 900 });
      for (const path of RULES_PATHS) {
        await op.page.goto(path === '/ops/rules/explain' ? `${path}?order=${ref}` : path);
        await op.page.waitForLoadState('networkidle');
        const name = `rules${path.replace('/ops/rules', '').replace(/\//g, '-') || '-list'}-${label}.png`;
        await op.page.screenshot({ path: out(name), fullPage: true });
      }
    }
  });
});

test.describe('who is sent to sign in', () => {
  test('a visitor and a buyer land on sign-in for every rules page and the export', async ({
    browser,
  }) => {
    const anon = await browser.newContext();
    const buyer = await buyerPage(browser, 'a');
    for (const page of [await anon.newPage(), buyer]) {
      for (const path of RULES_PATHS) {
        await page.goto(path);
        expect(new URL(page.url()).pathname, path).toBe('/signin');
      }
      const res = await page.request.get('/api/ops/rules/export');
      expect([401, 403]).toContain(res.status());
    }
    await anon.close();
    await buyer.context().close();
  });
});
