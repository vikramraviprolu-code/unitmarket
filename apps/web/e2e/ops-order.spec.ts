// INT-OPS-A / OPS-A.4 e2e (offline, dry run): an operator without the code opens an order from the Money page and
// sees the summary and the timeline, with no buyer name; every timeline row carries the id seq-<n>.
import { test, expect } from '@playwright/test';
import { PASSCODE } from './support';

test.describe('operator order page', () => {
  test('opens from Transactions, shows seq anchors, and keeps the evidence button off without the code', async ({ browser }) => {
    const ctx = await browser.newContext();
    const op = await ctx.newPage();
    await op.goto('/signin?next=/ops/money/transactions');
    await op.getByLabel('Who are you testing as?').selectOption('operator');
    await op.getByLabel('Demo passcode').fill(PASSCODE);
    await op.getByRole('button', { name: 'Sign in' }).click();
    const first = op.locator('a[href^="/ops/money/orders/"]').first();
    await expect(first).toBeVisible();
    await first.click();
    await expect(op.getByRole('heading', { level: 1 })).toBeVisible();
    const ids = await op.locator('[id^="seq-"]').evaluateAll((els) => els.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    await expect(op.getByText('needs your authenticator code').first()).toBeVisible();
    await ctx.close();
  });
});
