// DP-5 (MVP-D) e2e, offline on the dry run, keyboard only: a buyer picks two items from two
// publishers, approves once in UnitMarket, then once per publisher at the pretend PayPal with
// "Step 2 of 2" between, and sees one line per item. The partial journey declines the Harbour
// payment. Screenshots go to e2e/shots.
//
// File name and order: this spec is named so that it runs after refund.spec.ts and before
// zz-ops-stop.spec.ts. Both journeys use buyer B and the Harbour articles harbour-fees and
// knot-notebook, which refund.spec.ts has already bought and fully refunded (so they can be bought
// again), and which no later spec needs. The Playwright filter `composite.spec.ts` matches it.
import { mkdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { buyerPage, expectDryRun } from './support';

const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string): Promise<void> => {
  await page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });
};

/** The ref of the settled order of the partial journey (buyer B), used by the cancel page test. */
let settledOrderRef = '';

/** Keyboard only: focus the control, then press the key a person would. */
async function key(page: Page, target: ReturnType<Page['locator']>, k: 'Space' | 'Enter') {
  await target.focus();
  await page.keyboard.press(k);
}

async function pickTwo(
  page: Page,
  need: string,
  harbourTitle: RegExp,
  quaysideTitle: RegExp,
): Promise<void> {
  await page.goto('/discover');
  await page.getByLabel('What do you need?').fill(need);
  await key(page, page.getByRole('button', { name: 'Find articles' }), 'Enter');
  await expect(page.getByTestId('fit-card').first()).toBeVisible();
  // DP-5b L3: the disabled button is described by the hint beside it.
  await expect(page.getByRole('button', { name: 'Buy selected together' })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Buy selected together' }),
  ).toHaveAccessibleDescription('Select two or more articles to buy them together.');
  await key(page, page.getByLabel(/I accept the terms of purchase/), 'Space');
  await key(page, page.getByRole('checkbox', { name: harbourTitle }), 'Space');
  await key(page, page.getByRole('checkbox', { name: quaysideTitle }), 'Space');
  await key(page, page.getByRole('button', { name: 'Buy selected together' }), 'Enter');
  await expect(page).toHaveURL(/\/approve\//);
}

async function toDryRun(page: Page): Promise<void> {
  await expect(page.getByTestId('pack-notice')).toHaveText(
    'You will approve 2 payments at PayPal, one for each publisher. You are charged only after you have approved both.',
  );
  await expect(page.getByTestId('approve-block')).toHaveCount(2);
  await key(page, page.getByLabel(/I confirm the price and terms above/), 'Space');
  await key(page, page.getByRole('button', { name: 'Continue to payment' }), 'Enter');
  await expect(page).toHaveURL(/\/checkout\/dry-run\//);
  await expectDryRun(page);
}

/** The next dry-run payment still awaiting approval, with the outcome chosen per publisher. */
async function approveNext(
  page: Page,
  outcome: { harbour: string; quayside: string },
): Promise<void> {
  const form = page
    .locator('[data-testid^="dryrun-step-"]')
    .filter({ has: page.getByRole('button', { name: /^Approve payment \d of 2 \(dry run\)$/ }) })
    .first();
  const heading = (await form.getByRole('heading').textContent()) ?? '';
  const scenario = heading.includes('Harbour') ? outcome.harbour : outcome.quayside;
  await form.getByRole('combobox').focus();
  await form.getByRole('combobox').selectOption(scenario);
  await key(
    page,
    form.getByRole('button', { name: /^Approve payment \d of 2 \(dry run\)$/ }),
    'Enter',
  );
}

test.describe('composite pack on the dry run (keyboard only)', () => {
  test('happy: two approvals with Step 2 of 2 between, two lines ready', async ({ browser }) => {
    const page = await buyerPage(browser, 'b');
    await pickTwo(
      page,
      'harbour charges and the quayside market, under $5',
      /small harbour charges/i,
      /quayside market moved indoors/i,
    );
    await shot(page, 'dp5-approve');
    await toDryRun(page);
    await approveNext(page, { harbour: 'happy', quayside: 'happy' });
    await expect(page.getByTestId('step-heading')).toContainText(
      /^Step 2 of 2: approve your payment to .+ at PayPal$/,
    );
    await expect(page.getByTestId('step-deadline')).toHaveText(
      'If you do not approve within 60 minutes, the whole order may be cancelled and nothing is charged.',
    );
    await expectDryRun(page);
    await shot(page, 'dp5-step-2-of-2');
    // DP-5b H1: PayPal's cancel URL carries the order ref; the cancel page's link goes back to this
    // same Step 2 of 2 page while a payment still waits.
    const ref = new URL(page.url()).searchParams.get('ref') ?? '';
    expect(ref).toMatch(/^ord_/);
    await page.goto(`/checkout/cancel?ref=${encodeURIComponent(ref)}`);
    await key(page, page.getByTestId('cancel-back'), 'Enter');
    await expect(page.getByTestId('step-heading')).toContainText(/^Step 2 of 2/);
    // No automatic redirect: the page stays until the buyer presses the one button.
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/checkout\/return/);
    await key(page, page.getByRole('link', { name: /Approve payment 2 of 2 at PayPal/ }), 'Enter');
    await expect(page).toHaveURL(/\/checkout\/dry-run\//);
    await approveNext(page, { harbour: 'happy', quayside: 'happy' });
    await expect(page).toHaveURL(/\/orders\//);
    const items = page.getByTestId('order-item');
    await expect(items).toHaveCount(2);
    for (const i of [0, 1]) await expect(items.nth(i)).toContainText('Ready in your library');
    await expectDryRun(page);
    await shot(page, 'dp5-order-both-ready');
  });

  test('partial: the second payment is declined, one ready and one Not charged', async ({
    browser,
  }) => {
    const page = await buyerPage(browser, 'b');
    await pickTwo(
      page,
      'a notebook of six working knots and a walk along the old quay, under $5',
      /six working knots/i,
      /morning walk along the old quay/i,
    );
    await toDryRun(page);
    await approveNext(page, { harbour: 'declined', quayside: 'happy' });
    await expect(page.getByTestId('step-heading')).toContainText(/^Step 2 of 2/);
    await key(page, page.getByRole('link', { name: /Approve payment 2 of 2 at PayPal/ }), 'Enter');
    await approveNext(page, { harbour: 'declined', quayside: 'happy' });
    await expect(page).toHaveURL(/\/orders\//);
    settledOrderRef = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
    const live = page.getByTestId('order-live');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(
      live.getByTestId('order-item').filter({ hasText: 'Ready in your library' }),
    ).toHaveCount(1);
    await expect(
      live
        .getByTestId('order-item')
        .filter({ hasText: 'Not charged: PayPal declined this payment' }),
    ).toHaveCount(1);
    await expectDryRun(page);
    await shot(page, 'dp5-order-partial');
  });

  test('the cancel page says nothing was charged, is static, and links back to the order', async ({
    browser,
  }) => {
    const page = await buyerPage(browser, 'b');
    // No ref (or a bad one): no promise and no link back, only the library.
    for (const bad of ['', '?ref=', '?ref=../ops', '?ref=javascript:alert(1)']) {
      await page.goto(`/checkout/cancel${bad}`);
      await expect(page.getByTestId('cancel-body')).toHaveText(
        'You did not approve this payment at PayPal. Nothing was charged for this payment.',
      );
      await expect(page.getByTestId('cancel-window')).toHaveCount(0);
      await expect(page.getByTestId('cancel-back')).toHaveCount(0);
      await expect(page.getByRole('main').getByRole('link', { name: 'My library' })).toBeVisible();
    }
    // A valid ref: the sentence and the link; the link keeps the promise (it ends on the order page
    // here, because this order is settled; the happy journey shows the Step 2 of 2 landing).
    expect(settledOrderRef).toMatch(/^ord_/);
    await page.goto(`/checkout/cancel?ref=${encodeURIComponent(settledOrderRef)}`);
    await expect(
      page.getByRole('heading', { name: 'You did not approve this payment' }),
    ).toBeVisible();
    await expect(page.getByTestId('cancel-body')).toHaveText(
      'You did not approve this payment at PayPal. Nothing was charged for this payment. If you approved another payment of this order, it will not be taken unless you approve the rest.',
    );
    await expect(page.getByTestId('cancel-window')).toHaveText(
      'If the order window is still open, you can go back to your order and approve this payment.',
    );
    const back = page.getByTestId('cancel-back');
    await expect(back).toHaveText('Go back to your order');
    await expect(back).toHaveAttribute(
      'href',
      `/checkout/return?ref=${encodeURIComponent(settledOrderRef)}`,
    );
    await expect(page.getByRole('main').getByRole('link', { name: 'My library' })).toBeVisible();
    await expectDryRun(page);
    await shot(page, 'dp5b-cancel');
    await key(page, back, 'Enter');
    await expect(page).toHaveURL(new RegExp(`/orders/${settledOrderRef}$`));
  });
});
