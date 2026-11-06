// INT-OPS-C e2e (offline, dry run, no purchase of its own): the operator buyer, seller, Agents and API and ledger
// pages render. Without the authenticator code the buyer page shows only the notice and Agents and API shows no
// whole key id; with the code the buyer and seller pages open from ids the operator list gives. No page HTML
// carries a webhook signing secret or a key hash. The file name sorts after shell.spec.ts and before
// zcomposite.spec.ts, so the operator codes rise in order (operator-session.ts retries a spent step).
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { PASSCODE } from './support';
import { operatorWithCode } from './operator-session';

function cleanHtml(html: string): void {
  expect(html).not.toContain('whsec_');
  expect(html).not.toMatch(/secret_hash|signing_secret/);
}

async function demoOperator(page: Page, next: string): Promise<void> {
  await page.goto(`/signin?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Who are you testing as?').selectOption('operator');
  await page.getByLabel('Demo passcode').fill(PASSCODE);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('operator detail pages (INT-OPS-C)', () => {
  test('without the code: the buyer page is only the notice and Agents and API shows key ids as last four', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await demoOperator(page, '/ops/agents');
    await expect(page.getByRole('heading', { level: 1, name: 'Agents and API' })).toBeVisible();
    const html = await page.content();
    cleanHtml(html);
    expect(html).not.toMatch(/key_[0-9a-hjkmnp-tv-z]{26}/);
    await page.goto('/ops/buyers/buy_e2e_unknown');
    await expect(page.getByText('needs your authenticator code').first()).toBeVisible();
    await page.goto('/ops/money');
    await expect(page.getByRole('heading', { name: 'Totals by kind' })).toBeVisible();
    await ctx.close();
  });

  test('with the code: buyer, seller and ledger pages open and say which environment they show', async ({
    browser,
  }) => {
    const op = await operatorWithCode(browser);
    const res = await op.page.request.get('/api/ops/transactions');
    expect(res.status()).toBe(200);
    const items = ((await res.json()) as { items: { buyer_id: string; publisher_id: string }[] })
      .items;
    expect(items.length).toBeGreaterThan(0);
    const { buyer_id, publisher_id } = items[0]!;

    await op.page.goto(`/ops/buyers/${buyer_id}`);
    await expect(op.page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(op.page.getByRole('table', { name: 'Orders of this buyer' })).toBeVisible();
    cleanHtml(await op.page.content());

    await op.page.goto(`/ops/sellers/${publisher_id}`);
    await expect(op.page.getByRole('table', { name: 'Sales of this seller' })).toBeVisible();
    cleanHtml(await op.page.content());

    await op.page.goto('/ops/agents');
    cleanHtml(await op.page.content());

    await op.page.goto('/ops/money');
    const link = op.page.locator('a[href^="/ops/money/ledger?"]').first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(op.page.getByRole('table', { name: 'Ledger lines' })).toBeVisible();
    await expect(op.page.getByTestId('env-label').first()).toContainText(/Dry run|Sandbox/);

    await op.page.goto('/ops');
    await expect(op.page.getByRole('list', { name: 'Money flow, last 24 hours' })).toBeVisible();
    await op.ctx.close();
  });
});
