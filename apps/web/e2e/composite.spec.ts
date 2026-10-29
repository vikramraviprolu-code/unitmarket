// DP-5 (MVP-D) e2e, offline on the dry run, keyboard only: a buyer picks two items from two
// publishers, approves once in UnitMarket, then once per publisher at the pretend PayPal with
// "Step 2 of 2" between, and sees one line per item. The partial journey declines the second
// payment. Screenshots go to e2e/shots. Each journey uses its own buyer and its own articles
// (dock-history and the two Quayside articles are used by no other spec).
import { mkdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { buyerPage, expectDryRun } from './support';

const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string): Promise<void> => {
  await page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });
};

/** Keyboard only: focus the control, then press the key a person would. */
async function key(page: Page, target: ReturnType<Page['locator']>, k: 'Space' | 'Enter') {
  await target.focus();
  await page.keyboard.press(k);
}

async function pickTwo(page: Page, harbourTitle: RegExp, quaysideTitle: RegExp): Promise<void> {
  await page.goto('/discover');
  await page
    .getByLabel('What do you need?')
    .fill('dock history and the quay market walk, under $5, read online');
  await key(page, page.getByRole('button', { name: 'Find articles' }), 'Enter');
  await expect(page.getByTestId('fit-card').first()).toBeVisible();
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

async function approveDryRunStep(page: Page, n: number, scenario: string): Promise<void> {
  const form = page.getByTestId(`dryrun-step-${String(n)}`);
  await form.getByRole('combobox').focus();
  await form.getByRole('combobox').selectOption(scenario);
  await key(
    page,
    form.getByRole('button', { name: new RegExp(`Approve payment ${String(n)} of 2`) }),
    'Enter',
  );
}

test.describe('composite pack on the dry run (keyboard only)', () => {
  test('happy: two approvals with Step 2 of 2 between, two lines ready', async ({ browser }) => {
    const page = await buyerPage(browser, 'a');
    await pickTwo(page, /dock that was never finished/i, /quayside market moved indoors/i);
    await shot(page, 'dp5-approve');
    await toDryRun(page);
    await approveDryRunStep(page, 1, 'happy');
    await expect(page.getByTestId('step-heading')).toContainText(
      /^Step 2 of 2: approve your payment to .+ at PayPal$/,
    );
    await expect(page.getByTestId('step-deadline')).toHaveText(
      'If you do not approve within 60 minutes, the whole order may be cancelled and nothing is charged.',
    );
    await expectDryRun(page);
    await shot(page, 'dp5-step-2-of-2');
    // No automatic redirect: the page stays until the buyer presses the one button.
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/checkout\/return/);
    await key(page, page.getByRole('link', { name: /Approve payment 2 of 2 at PayPal/ }), 'Enter');
    await expect(page).toHaveURL(/\/checkout\/dry-run\//);
    await approveDryRunStep(page, 2, 'happy');
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
    await pickTwo(page, /dock that was never finished/i, /morning walk along the old quay/i);
    await toDryRun(page);
    await approveDryRunStep(page, 1, 'happy');
    await expect(page.getByTestId('step-heading')).toContainText(/^Step 2 of 2/);
    await key(page, page.getByRole('link', { name: /Approve payment 2 of 2 at PayPal/ }), 'Enter');
    await approveDryRunStep(page, 2, 'declined');
    await expect(page).toHaveURL(/\/orders\//);
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

  test('the cancel page says nothing was charged and is static', async ({ browser }) => {
    const page = await buyerPage(browser, 'a');
    await page.goto('/checkout/cancel');
    await expect(
      page.getByRole('heading', { name: 'You did not approve this payment' }),
    ).toBeVisible();
    await expect(page.getByTestId('cancel-body')).toHaveText(
      'You did not approve this payment at PayPal. Nothing was charged. If you approved another payment of this order, it will not be taken unless you approve the rest.',
    );
    await expectDryRun(page);
    await shot(page, 'dp5-cancel');
  });
});
