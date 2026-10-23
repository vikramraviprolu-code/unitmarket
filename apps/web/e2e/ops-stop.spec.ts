// BU-2 e2e (offline, dry run): the operator presses "Stop PayPal now" on /ops; the next checkout shows
// that it is paused and nothing is charged. Runs last (file name order) because the stop stays in
// force for the life of the server. The operator signs in through the sign-in form; the buyer is
// buyer B from the setup project.
import { test, expect } from '@playwright/test';
import { PASSCODE, askPrice, buyerPage, toApproval } from './support';

test.describe('stop button', () => {
  test('operator presses Stop PayPal now; the buyer then sees that checkout is paused', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const op = await ctx.newPage();
    await op.goto('/signin?next=/ops');
    await op.getByLabel('Who are you testing as?').selectOption('operator');
    await op.getByLabel('Demo passcode').fill(PASSCODE);
    await op.getByRole('button', { name: 'Sign in' }).click();
    await expect(op.getByRole('heading', { level: 1, name: /Operations/ })).toBeVisible();
    await expect(op.getByTestId('ops-kill-switch')).toContainText('On');

    await op.getByLabel('Why are you stopping PayPal calls?').fill('e2e drill');
    await op.getByRole('button', { name: 'Stop PayPal now' }).click();
    await expect(op.getByTestId('ops-stop-result')).toContainText('PayPal calls are stopped');
    await op.reload();
    await expect(op.getByTestId('ops-kill-switch')).toContainText('Off');
    await expect(op.getByTestId('ops-kill-switch')).toContainText('e2e drill');

    // The switch reader caches for up to 5 s (MAX_SWITCH_CACHE_MS, RLR-3), so a stop is in force
    // within 5 s; wait that long before the buyer tries.
    await op.waitForTimeout(5500);
    // A buyer now tries to pay: checkout is paused and nothing is charged.
    const buyer = await buyerPage(browser, 'b');
    await askPrice(buyer, { offer: 'tide-tables' });
    await toApproval(buyer);
    // The box may be ticked before the page has hydrated, which resets it: tick until the button enables.
    const pay = buyer.getByRole('button', { name: 'Continue to payment' });
    await expect(async () => {
      await buyer.getByLabel(/I confirm the price and terms above/).check();
      await expect(pay).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await pay.click();
    await expect(buyer.getByText(/Checkout is paused/)).toBeVisible();
    await expect(buyer.getByText(/Nothing was charged/)).toBeVisible();
    await expect(buyer).not.toHaveURL(/\/checkout\/dry-run\//);
    await ctx.close();
  });

  test('a buyer session has no stop button and cannot call the route', async ({ browser }) => {
    const buyer = await buyerPage(browser, 'a');
    const res = await buyer.goto('/ops');
    expect(new URL(buyer.url()).pathname).toBe('/signin');
    expect(res?.status()).toBeLessThan(500);
    await expect(buyer.getByRole('button', { name: 'Stop PayPal now' })).toHaveCount(0);
  });
});
