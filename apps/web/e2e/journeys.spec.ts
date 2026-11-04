// Lane 15 e2e (offline, dry-run). Journeys that need the payments lane (05a) are test.fixme with
// the lane named; they are written against the final page text so they run once 05a is wired.
// PUB-B: tide tables read $1.00 here, not $0.40. The e2e server runs with NODE_ENV=production, so the demo
// price step (decision 37) applies at boot. The earlier $0.40 contradicted decision 37.
import { test, expect } from '@playwright/test';
import { askPrice, buyerPage, expectDryRun, payWithScenario, toApproval } from './support';

test.describe('offer and discovery journeys up to the approval screen', () => {
  test('offer journey: offer, quote, terms, approval screen with the frozen total (A-12 first half)', async ({
    browser,
  }) => {
    const page = await buyerPage(browser);
    await askPrice(page);
    await expect(page.getByTestId('quote-price')).toHaveText('$1.00');
    await toApproval(page);
    await expect(page.getByRole('heading', { name: 'Approve your purchase' })).toBeVisible();
    await expect(page.getByTestId('approve-total')).toHaveText('$1.00');
  });

  test('ceiling below price shows no match without alternatives (A-05)', async ({ browser }) => {
    const page = await buyerPage(browser);
    await askPrice(page, { ceiling: '0.10' });
    const result = page.getByTestId('quote-result');
    await expect(result).toContainText('No match');
    await expect(result.getByRole('link')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review and approve' })).toHaveCount(0);
  });

  test('discovery journey reaches the same approval screen (B-11 offline twin)', async ({
    browser,
  }) => {
    const page = await buyerPage(browser);
    await page.goto('/discover');
    await page.getByLabel('What do you need?').fill('tide tables, under $1, read online');
    await page.getByRole('button', { name: 'Find articles' }).click();
    const card = page.getByTestId('fit-card').first();
    await expect(card).toBeVisible();
    await expect(card).not.toContainText('%');
    await page.getByLabel(/I accept the terms of purchase/).check();
    await card.getByRole('button', { name: 'Choose this article' }).click();
    await expect(page).toHaveURL(/\/approve\//);
    await expect(page.getByRole('heading', { name: 'Approve your purchase' })).toBeVisible();
  });
});

test.describe('page security (SOP 10, P8)', () => {
  test('CSP and security headers on every page, nonce on every script, no card field (P8)', async ({
    browser,
  }) => {
    const page = await buyerPage(browser);
    const paths = [
      '/',
      '/signin',
      '/discover',
      '/library',
      '/o/harbour-ledger/tide-tables',
      '/help/payment',
    ];
    for (const path of paths) {
      const res = await page.goto(path);
      const h = res?.headers() ?? {};
      expect(h['content-security-policy'], path).toContain("frame-ancestors 'none'");
      expect(h['x-content-type-options'], path).toBe('nosniff');
      expect(h['strict-transport-security'], path).toBeDefined();
      const nonce = /nonce-([A-Za-z0-9_-]+)/.exec(h['content-security-policy'] ?? '')?.[1];
      expect(nonce, path).toBeTruthy();
      // The DOM hides the nonce attribute, so read the served HTML.
      const html = (await res?.text()) ?? '';
      const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g)].map((m) => m[0]);
      const bad = inline.filter((tag) => !tag.includes(`nonce="${nonce}"`));
      expect(bad, `${path} inline scripts without the nonce`).toEqual([]);
      const card = await page
        .locator('input[name*="card" i], input[autocomplete^="cc-"], input[name*="cvv" i]')
        .count();
      expect(card, `${path} card-like input`).toBe(0);
    }
  });
});

test.describe('labels and accessibility', () => {
  test('every money page shows Dry run (A-22)', async ({ browser }) => {
    const page = await buyerPage(browser);
    await askPrice(page);
    await toApproval(page);
    for (const path of [
      '/',
      page.url().replace(/^https?:\/\/[^/]+/, ''),
      '/discover',
      '/library',
    ]) {
      await page.goto(path);
      await expectDryRun(page);
    }
  });

  test('full flow by keyboard (A11Y-1)', async ({ page }) => {
    await page.goto('/signin');
    await page.getByLabel('Who are you testing as?').focus();
    await page.keyboard.press('ArrowDown'); // Buyer B
    await page.keyboard.press('Tab');
    await page.keyboard.type('e2e passcode one');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('link', { name: 'My library' })).toBeVisible();
    await page.goto('/o/harbour-ledger/tide-tables');
    await page.getByLabel('Read online').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab'); // ceiling
    await page.keyboard.type('1.00');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('quote-price')).toHaveText('$1.00');
    await page.getByLabel('I accept the terms of this purchase.').focus();
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Review and approve' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/approve\//);
  });

  test('status changes are announced through an aria-live region (A11Y-4, quote result)', async ({
    browser,
  }) => {
    const page = await buyerPage(browser);
    await askPrice(page, { ceiling: '0.10' });
    const live = page.locator('[aria-live="polite"][data-testid="quote-result"]');
    await expect(live).toContainText('No match');
  });

  test('approval countdown warns at 2 minutes and renews in one step (A11Y-5)', async ({
    browser,
  }) => {
    const page = await buyerPage(browser);
    await page.clock.install();
    await askPrice(page);
    await toApproval(page);
    const first = page.url();
    await expect(page.getByTestId('countdown')).toBeVisible();
    await expect(page.getByTestId('countdown-live')).not.toContainText('Two minutes left');
    await page.clock.runFor('13:10');
    await expect(page.getByTestId('countdown-live')).toContainText('Two minutes left');
    await page.getByRole('button', { name: /Renew for another 15 minutes/ }).click();
    await expect(page).toHaveURL(/\/approve\//);
    await expect.poll(() => page.url()).not.toBe(first);
  });
});

test.describe('payments journeys (real engine over the dry-run model, no PayPal)', () => {
  test('offer journey: approve, dry-run approve, return, library shows Ready with 5 days, receipt hash matches (A-12, PAY-09)', async ({
    browser,
  }) => {
    const page = await buyerPage(browser);
    await payWithScenario(page, { offer: 'tide-tables', scenario: 'happy' });
    const live = page.getByTestId('order-live');
    await expect(live).toContainText('Paid. Your item is in your library.');
    await expectDryRun(page);
    const receiptHref = await page.getByRole('link', { name: 'View receipt' }).getAttribute('href');
    expect(receiptHref).toMatch(/^\/receipts\/ord_/);
    await page.getByRole('link', { name: 'Open my library' }).click();
    const item = page.getByTestId('library-item').filter({ hasText: 'tide table' }).first();
    await expect(item.getByTestId('library-status')).toContainText(
      /Ready, (5 days|4 days 2\d hours) left/,
    );
    await page.goto(receiptHref ?? '/');
    const shown = (await page.getByTestId('receipt-sha256').textContent())?.trim();
    expect(shown).toMatch(/^[0-9a-f]{64}$/);
    const orderId = decodeURIComponent((receiptHref ?? '').split('/').pop() ?? '');
    const api = await page.request.get(`/api/receipts/${encodeURIComponent(orderId)}`);
    expect(api.status()).toBe(200);
    expect(((await api.json()) as { sha256: string }).sha256).toBe(shown);
  });

  test('claim-only scenario shows Confirming payment (A-11)', async ({ browser }) => {
    const page = await buyerPage(browser);
    await payWithScenario(page, { offer: 'ferry-timetables', scenario: 'capture_202' });
    await expect(page.getByTestId('order-live')).toContainText('Confirming payment');
    await expect(page.getByRole('link', { name: 'Open my library' })).toHaveCount(0);
  });

  test('pending scenario shows Awaiting seller acceptance (A-16, MC2-L6)', async ({ browser }) => {
    const page = await buyerPage(browser);
    await payWithScenario(page, { offer: 'harbour-fees', scenario: 'pending_receiving_pref' });
    await expect(page.getByTestId('order-live')).toContainText('Awaiting seller acceptance');
    await expect(page.getByRole('link', { name: 'Open my library' })).toHaveCount(0);
  });

  test('mismatch scenario shows a calm frozen message and a case (A-13)', async ({ browser }) => {
    const page = await buyerPage(browser);
    await payWithScenario(page, { offer: 'knot-notebook', scenario: 'mismatch_amount' });
    const live = page.getByTestId('order-live');
    await expect(live).toContainText('on hold while we check it');
    await expect(live).toContainText('You have not been charged twice');
    await expect(live).not.toContainText(/error|failed|exception/i);
    // The recovery rules run in the in-process job loop; the order page then names the case.
    await page.goto(page.url());
    await expect(page.getByTestId('order-case')).toContainText(/case/i, { timeout: 20_000 });
  });

  test('order status changes are announced in the aria-live region (A11Y-4, order page)', async ({
    browser,
  }) => {
    const page = await buyerPage(browser, 'b');
    await payWithScenario(page, { offer: 'tide-tables', scenario: 'happy' });
    const live = page.locator('[aria-live="polite"][data-testid="order-live"]');
    await expect(live).toHaveAttribute('aria-atomic', 'true');
    await expect(live).toContainText('Paid. Your item is in your library.');
  });
});
