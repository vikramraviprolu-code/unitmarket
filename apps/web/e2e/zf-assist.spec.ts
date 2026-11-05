// INT-GA e2e (offline, dry run, scripted model): the ask box and the explain panel in the built app. A fresh buyer types
// plain words on Spending, sees the proposed chips, and only "Apply these filters" changes the URL. The same buyer's
// order that PayPal (dry run) holds for an amount mismatch is in the attention group, so an operator with the code sees
// the explain panel on its order page, with at most one link and no form. Light and dark screenshots go to the test
// output folder (test-results), which git ignores.
import { test, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { operatorWithCode } from './operator-session';
import { payWithScenario } from './support';

async function shot(page: Page, name: string, info: TestInfo): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: info.outputPath(`${name}-${scheme}.png`), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

let page: Page;
const PW = 'amber kites drift slowly';
test.describe.configure({ mode: 'serial' });

test.describe('GA: ask box and explain panel', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({
      extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.91' },
    });
    page = await ctx.newPage();
    await page.goto('/signup');
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Display name').fill('Assist Buyer');
    await page.getByLabel('Username').fill('e2e.assist');
    await page.getByLabel(/^Country/).fill('US');
    await page.getByLabel('Password', { exact: true }).fill(PW);
    await page.getByLabel('Repeat password').fill(PW);
    await page.getByRole('checkbox', { name: /I accept the Terms and the Privacy notice/ }).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/discover$/);
  });
  test.afterAll(async () => {
    await page.context().close();
  });

  test('the ask box proposes chips, and only Apply changes the page', async () => {
    await page.goto('/buyer/spending');
    const box = page.getByTestId('ask-box');
    await expect(box).toBeVisible();
    await box
      .getByRole('textbox', { name: 'Ask in your own words' })
      .fill('paid orders today by my agent');
    await box.getByRole('button', { name: 'Ask' }).click();
    const chips = page.getByTestId('ask-chips');
    await expect(chips).toContainText('Paid');
    await expect(page).not.toHaveURL(/status=/);
    await shot(page, 'ask-box', test.info());
    await chips.getByRole('button', { name: /Leave out .*Agent/ }).click();
    await expect(chips).not.toContainText('Agent');
    await page.getByRole('button', { name: 'Apply these filters' }).click();
    await expect(page).toHaveURL(/status=paid/);
    await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}/);
    await expect(page).not.toHaveURL(/channel=/);
    await expect(page.getByTestId('filter-chips')).toContainText('Paid');
  });

  test('a held order shows the explain panel to an operator, with one link and no form', async ({
    browser,
  }) => {
    await payWithScenario(page, { offer: 'harbour-fees', scenario: 'mismatch_amount' });
    const ref = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
    expect(ref).toMatch(/^ord_/);
    const { ctx, page: op } = await operatorWithCode(browser);
    await op.goto(`/ops/money/orders/${ref}`);
    const panel = op.getByTestId('order-explain');
    await expect(panel).toBeVisible();
    await expect(op.getByTestId('explain-what')).not.toBeEmpty();
    await expect(op.getByTestId('explain-safe')).not.toBeEmpty();
    await expect(panel.locator('form')).toHaveCount(0);
    expect(await panel.locator('a').count()).toBeLessThanOrEqual(1);
    await shot(op, 'explain-panel', test.info());
    await ctx.close();
  });
});
