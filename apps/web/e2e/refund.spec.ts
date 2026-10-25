// CO-8 e2e (offline, dry run): the whole refund journey in a browser. A buyer pays; an operator signs in
// with a TOTP code (the server holds the public RFC 6238 test key, see playwright.config.ts), refunds
// part of it from /ops, and the buyer, who has the library item open, sees "Partially refunded" arrive
// in an aria-live region without reloading. The operator then refunds the rest by keyboard, and the
// buyer sees "Refunded" and cannot open the item. Runs before the ops stop drill (zz-ops-stop.spec.ts):
// that stop stays in force for the life of the server and would block every PayPal call, refunds included.
import { createHmac } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { PASSCODE, TOTP_KEY_BYTES, buyerPage, expectDryRun, payWithScenario } from './support';

async function nextCode(page: Page): Promise<string> {
  // One step ahead of the server clock: the earlier sign-in spec used the current step, and a step
  // may be used once, in rising order. The server accepts one step either side.
  const res = await page.request.get('/healthz');
  const serverMs = new Date(res.headers()['date'] ?? '').getTime();
  expect(Number.isFinite(serverMs)).toBe(true);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(serverMs / 30_000) + 1));
  const mac = createHmac('sha1', TOTP_KEY_BYTES).update(msg).digest();
  const o = (mac[19] ?? 0) & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function operatorWithCode(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/signin?next=/ops');
  await page.getByLabel('Who are you testing as?').selectOption('operator');
  await page.getByLabel('Operator name').fill('vikram');
  await page.getByLabel('Demo passcode').fill(PASSCODE);
  await page.getByLabel('Authenticator code').fill(await nextCode(page));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Operations/ })).toBeVisible();
  return { ctx, page };
}

const unitCard = (page: Page, title: string) =>
  page.getByTestId('refund-unit').filter({ hasText: title });

// CO-8c: counts the page's own data re-reads (router.refresh sends an RSC request for the current
// path; link prefetches carry next-router-prefetch and are not counted).
function countRefreshes(page: Page): () => number {
  let n = 0;
  page.on('request', (r) => {
    const h = r.headers();
    if (
      h['rsc'] === '1' &&
      h['next-router-prefetch'] === undefined &&
      new URL(r.url()).pathname === '/ops'
    )
      n += 1;
  });
  return () => n;
}

const jsonAnswer = (status: number, body: unknown) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

test.describe.serial('refund journey', () => {
  let op: { ctx: BrowserContext; page: Page };
  test.beforeAll(async ({ browser }) => {
    op = await operatorWithCode(browser);
  });
  test.afterAll(async () => {
    await op.ctx.close();
  });

  test('buyer buys; operator refunds part; buyer sees Partially refunded; operator refunds the rest by keyboard; buyer sees Refunded and cannot open it', async ({
    browser,
  }) => {
    // 1. The buyer pays 2.50 for an online item.
    const buyer = await buyerPage(browser, 'b');
    await payWithScenario(buyer, { offer: 'harbour-fees', scenario: 'happy' });
    await expect(buyer.getByTestId('order-live')).toContainText(
      'Paid. Your item is in your library.',
    );
    await buyer.getByRole('link', { name: 'Open my library' }).click();
    const item = buyer
      .getByTestId('library-item')
      .filter({ hasText: 'What a small harbour charges and why' });
    await item.getByRole('link', { name: 'What a small harbour charges and why' }).click();
    await expect(buyer).toHaveURL(/\/library\/.+/);
    const status = buyer.locator('[aria-live="polite"][data-testid="library-status"]');
    await expect(status).toContainText(/Ready, /);
    await expectDryRun(buyer);

    // 2. The operator sees the refund form (second-factor session) and refunds 0.75.
    await op.page.goto('/ops');
    await expect(op.page.getByTestId('refund-no-mfa')).toHaveCount(0);
    const card = unitCard(op.page, 'What a small harbour charges and why');
    await expect(card).toContainText('$2.50');
    await expect(card.getByRole('button', { name: 'Refund the rest' })).toBeVisible();
    // L8: the panel says it lists only the newest units.
    await expect(op.page.getByTestId('refund-panel')).toContainText('50 newest');
    // L6: a disabled button says why (the reason is empty or too short).
    await expect(card.getByRole('button', { name: 'Refund the rest' })).toBeDisabled();
    await expect(card.getByTestId('refund-reason-hint')).toContainText('at least 3 characters');
    await expect(async () => {
      await card.getByLabel(/^Amount/).fill('0.75');
      await card.getByLabel(/^Reason/).fill('Part of the article was missing');
      await expect(card.getByRole('button', { name: 'Refund $0.75' })).toBeEnabled({
        timeout: 1000,
      });
    }).toPass({ timeout: 20_000 });
    await card.getByRole('button', { name: 'Refund $0.75' }).click();
    const result = op.page.locator('[aria-live="polite"][data-testid="refund-result"]');
    await expect(result).toContainText('Refunded $0.75');
    await expect(result).toContainText('$1.75 is left to refund');
    // L2: the answer names the payment it is about.
    await expect(result).toContainText('What a small harbour charges and why (order ');
    // Nit: a booked refund is the green success banner.
    await expect(result.locator('.banner-success')).toHaveCount(1);
    await expect(result.locator('.banner-warn')).toHaveCount(0);
    await expectDryRun(op.page);

    // 3. The buyer, who did not reload, is told in the live region.
    await expect(status).toContainText('Partially refunded: your access continues', {
      timeout: 20_000,
    });
    await expect(buyer.getByTestId('library-refund-note')).toContainText(
      'every item in the order continues',
    );
    await expect(buyer.getByRole('button', { name: 'Read online' })).toBeVisible();

    // 4. The operator refunds the rest, by keyboard only: amount empty, reason typed, button by Enter.
    await expect(
      op.page
        .getByTestId('refund-unit')
        .filter({ hasText: 'What a small harbour charges and why' }),
    ).toContainText('$1.75');
    const again = unitCard(op.page, 'What a small harbour charges and why');
    await expect(async () => {
      await again.getByLabel(/^Amount/).focus();
      await op.page.keyboard.press('Tab');
      await expect(again.getByLabel(/^Reason/)).toBeFocused();
      await op.page.keyboard.type('Refund the rest, customer is unhappy');
      await op.page.keyboard.press('Tab');
      await expect(again.getByRole('button', { name: 'Refund the rest' })).toBeFocused({
        timeout: 1000,
      });
      await expect(again.getByRole('button', { name: 'Refund the rest' })).toBeEnabled({
        timeout: 1000,
      });
    }).toPass({ timeout: 20_000 });
    await op.page.keyboard.press('Enter');
    await expect(result).toContainText('Refunded $1.75');
    await expect(result).toContainText('fully refunded');
    await expect(result).toContainText('(order ');
    // L6: the card is gone after a full refund, so focus moves to the answer.
    await expect(result).toBeFocused();

    // 5. The buyer sees Refunded and the item cannot be opened.
    await expect(status).toContainText('Refunded: access has ended', { timeout: 20_000 });
    await expect(buyer.getByRole('button', { name: 'Read online' })).toHaveCount(0);
    await buyer.goto('/library');
    const row = buyer
      .getByTestId('library-item')
      .filter({ hasText: 'What a small harbour charges and why' });
    await expect(row.getByTestId('library-status')).toHaveText('Refunded: access has ended');
    await expect(row.getByRole('button')).toHaveCount(0);
    // L4: the refund line is enough; the window meter does not add "Access was revoked."
    await expect(row).not.toContainText('Access was revoked');

    // 6. The receipt lists both refunds and the version.
    await buyer.goto('/library');
    await row.getByRole('link', { name: 'What a small harbour charges and why' }).click();
    await buyer.getByRole('link', { name: 'View receipt' }).click();
    await expectDryRun(buyer);
    await expect(buyer.getByTestId('receipt-version')).toContainText('Version 3');
    await expect(buyer.getByTestId('receipt-refund')).toHaveCount(2);
    await expect(buyer.getByTestId('receipt-refunds')).toContainText('$0.75');
    await expect(buyer.getByTestId('receipt-refunds')).toContainText('$1.75');
    await buyer.context().close();
  });

  test('a download-and-keep item: a too-large amount is refused in plain words, then the rest is refunded and the links stop', async ({
    browser,
  }) => {
    const buyer = await buyerPage(browser, 'b');
    await payWithScenario(buyer, {
      offer: 'knot-notebook',
      scenario: 'happy',
      option: 'Download and keep',
    });
    await expect(buyer.getByTestId('order-live')).toContainText('Paid.');
    await op.page.goto('/ops');
    const card = unitCard(op.page, 'A notebook of six working knots');
    const refreshes = countRefreshes(op.page);
    // M1: an answer that is not a clear refusal (a server error) must not say that nothing was refunded.
    await op.page.route('**/api/refunds', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'internal', message: 'Something went wrong.', support_code: 'e2e' },
        }),
      }),
    );
    await expect(async () => {
      await card.getByLabel(/^Amount/).fill('0.10');
      await card.getByLabel(/^Reason/).fill('Server error drill');
      await expect(card.getByRole('button', { name: 'Refund $0.10' })).toBeEnabled({
        timeout: 1000,
      });
    }).toPass({ timeout: 20_000 });
    await card.getByRole('button', { name: 'Refund $0.10' }).click();
    const unsure = op.page.getByTestId('error-state');
    await expect(unsure).toContainText('We do not know yet whether this refund was made');
    await expect(unsure).toContainText('Do not start a new refund');
    await expect(unsure).not.toContainText('Nothing was refunded');
    // CO-8c L2: an unknown outcome must not re-read the page. A refresh brings a new Idempotency-Key
    // and removes the replay protection.
    await op.page.waitForTimeout(1500);
    expect(refreshes()).toBe(0);
    // CO-8c L2: after refunds_paused_midway the open request and the paused banner are new, so the
    // page re-reads itself once, as the message ("Withdraw the open request on this page") promises.
    await op.page.unroute('**/api/refunds');
    await op.page.route('**/api/refunds', (route) =>
      route.fulfill(
        jsonAnswer(503, {
          error: {
            code: 'refunds_paused_midway',
            message:
              'Refunds were paused before it was sent. Nothing was refunded. Withdraw the open request on this page, then try again when refunds are on.',
          },
        }),
      ),
    );
    await card.getByRole('button', { name: 'Refund $0.10' }).click();
    await expect(op.page.getByTestId('error-state')).toContainText('Withdraw the open request');
    await expect.poll(refreshes).toBe(1);
    // CO-8c nit: a queued answer (202, state unknown) is a warning with a text label, not green.
    await op.page.unroute('**/api/refunds');
    await op.page.route('**/api/refunds', (route) =>
      route.fulfill(
        jsonAnswer(202, {
          refund_request_id: 'rr_e2e',
          unit_id: 'u_e2e',
          state: 'unknown',
          amount_minor: 10,
          currency: 'USD',
          refunded_minor: 0,
          remaining_minor: 250,
          unit_status: 'captured',
          message: 'Nothing was sent yet: PayPal could not be read. Mocked for this drill.',
        }),
      ),
    );
    await expect(card.getByRole('button', { name: 'Refund $0.10' })).toBeEnabled();
    await card.getByRole('button', { name: 'Refund $0.10' }).click();
    const queued = op.page.getByTestId('refund-result');
    await expect(queued.locator('.banner-warn')).toContainText('Not finished yet');
    await expect(queued.locator('.banner-warn')).toContainText('Mocked for this drill');
    await expect(queued.locator('.banner-success')).toHaveCount(0);
    await op.page.unroute('**/api/refunds');
    await expect(async () => {
      await card.getByLabel(/^Amount/).fill('9.99');
      await card.getByLabel(/^Reason/).fill('Trying too much on purpose');
      await expect(card.getByRole('button', { name: 'Refund $9.99' })).toBeEnabled({
        timeout: 1000,
      });
    }).toPass({ timeout: 20_000 });
    await card.getByRole('button', { name: 'Refund $9.99' }).click();
    await expect(op.page.getByTestId('error-state')).toContainText('more than is left to refund');
    await expect(op.page.getByTestId('error-state')).toContainText('Nothing was refunded');
    // The same form, the amount emptied: the rest.
    await card.getByLabel(/^Amount/).fill('');
    await expect(card.getByRole('button', { name: 'Refund the rest' })).toBeEnabled();
    await card.getByRole('button', { name: 'Refund the rest' }).click();
    await expect(op.page.getByTestId('refund-result')).toContainText('fully refunded');
    await buyer.goto('/library');
    const row = buyer
      .getByTestId('library-item')
      .filter({ hasText: 'A notebook of six working knots' });
    await expect(row.getByTestId('library-status')).toHaveText(
      'Refunded: links have stopped. The copy you downloaded cannot be recalled.',
    );
    await expect(row.getByRole('button', { name: 'Download' })).toHaveCount(0);
    await buyer.context().close();
  });
});

test.describe('who sees the refund form', () => {
  test('an operator without the authenticator code sees no form, only how to get one', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/signin?next=/ops');
    await page.getByLabel('Who are you testing as?').selectOption('operator');
    await page.getByLabel('Demo passcode').fill(PASSCODE);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /Operations/ })).toBeVisible();
    await expect(page.getByTestId('refund-no-mfa')).toContainText('authenticator code');
    await expect(page.getByTestId('refund-unit')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Refund/ })).toHaveCount(0);
    await ctx.close();
  });

  test('a buyer has no refund button anywhere and cannot reach /ops', async ({ browser }) => {
    const buyer = await buyerPage(browser, 'a');
    for (const path of ['/library', '/orders/none', '/receipts/none']) {
      await buyer.goto(path);
      await expect(buyer.getByRole('button', { name: /refund/i })).toHaveCount(0);
    }
    await buyer.goto('/ops');
    expect(new URL(buyer.url()).pathname).toBe('/signin');
    await buyer.context().close();
  });
});
