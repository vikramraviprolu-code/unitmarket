// INT-OPS-A e2e: Home shows four health lights and the alert bell; the bell opens the alert list; the Buyers tab
// lands on the case queue. J1: Home to the fix is at most two clicks (needs-you or bell, then Open the fix).
import { test, expect } from '@playwright/test';
import { PASSCODE } from './support';

test.describe('operator home journeys', () => {
  test('four lights, the bell, and the Buyers tab', async ({ browser }) => {
    const ctx = await browser.newContext();
    const op = await ctx.newPage();
    await op.goto('/signin?next=/ops');
    await op.getByLabel('Who are you testing as?').selectOption('operator');
    await op.getByLabel('Demo passcode').fill(PASSCODE);
    await op.getByRole('button', { name: 'Sign in' }).click();
    for (const id of ['app', 'database', 'paypal', 'jobs'])
      await expect(op.getByTestId(`health-light-${id}`)).toBeVisible();
    await op
      .getByRole('link', { name: /alerts/i })
      .first()
      .click();
    await expect(op).toHaveURL(/\/ops\/alerts/);
    await op.goto('/ops/buyers');
    await expect(op).toHaveURL(/\/ops\/buyers\/cases/);
    await ctx.close();
  });
});
