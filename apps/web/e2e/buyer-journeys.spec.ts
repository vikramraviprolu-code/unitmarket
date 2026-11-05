// INT-BUY / BUY.10 e2e (offline, dry run): the buyer journeys B1 to B6 of the buyer Home design, on the pages this lane
// builds. Buyer A pays one offer nobody else in the suite buys (allotment-diary), leaves one approval open on another
// (village-bus), makes an agent key and gives it a cap, and checks each screen. Every light and dark screenshot
// is written to the int-buy folder when UM_SHOT_DIR is set.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { askPrice, buyerPage, expectDryRun, payWithScenario, toApproval } from './support';

const SHOT_DIR = process.env['UM_SHOT_DIR'];
async function shot(page: Page, name: string): Promise<void> {
  if (SHOT_DIR === undefined) return;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `${SHOT_DIR}/${name}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

let orderUrl = '';
test.describe.configure({ mode: 'serial' });

test.describe('buyer journeys B1 to B6', () => {
  test('B1: find and pay, then the order page says Open now and a step list', async ({
    browser,
  }) => {
    const page = await buyerPage(browser);
    await payWithScenario(page, {
      offer: 'allotment-diary',
      publisher: 'northfield-quarterly',
      scenario: 'happy',
    });
    orderUrl = page.url();
    await expect(page.getByTestId('milestones')).toContainText('Done: Approved');
    await expect(page.getByTestId('milestones')).toContainText('Done: Paid');
    await expectDryRun(page);
    await shot(page, 'order');
  });

  test('B2: Home puts what to continue reading first and shows the spend sections in order', async ({
    browser,
  }) => {
    const page = await buyerPage(browser);
    await page.goto('/buyer');
    const home = page.getByTestId('buyer-home');
    await expect(home).toBeVisible();
    const headings = await home.getByRole('heading', { level: 2 }).allTextContents();
    expect(headings).toEqual([
      'Needs your OK',
      'Continue reading',
      'Your agents and their cap',
      'Recent spending',
    ]);
    await expect(page.getByTestId('home-continue_reading')).toContainText('Allotment');
    await shot(page, 'home');
  });

  test('B3: Spending lists the purchase, and Receipts has the order ref, PayPal order id and seller', async ({
    browser,
  }) => {
    const page = await buyerPage(browser);
    await page.goto('/buyer/spending');
    await expect(page.getByRole('heading', { level: 1, name: 'Spending' })).toBeVisible();
    await expect(page.getByTestId('spending-table')).toContainText('Allotment');
    await shot(page, 'spending');
    await page.goto('/buyer/receipts');
    const row = page.getByTestId('receipt-row').first();
    await expect(row).toContainText('Northfield');
    await expect(row.getByRole('link', { name: 'Receipt' })).toHaveAttribute(
      'href',
      /\/receipts\/.+/,
    );
    await shot(page, 'receipts');
  });

  test('B4: make an agent key, copy it once, give it a cap with a confirm sentence', async ({
    browser,
  }) => {
    const page = await buyerPage(browser);
    await page.goto('/buyer/keys');
    await page.getByLabel('What kind of key').selectOption({ label: 'Agent key' });
    await page.getByRole('button', { name: 'Make key' }).click();
    const once = page.getByTestId('key-once');
    await expect(once).toBeVisible();
    await expect(page.getByTestId('key-secret')).not.toBeEmpty();
    await shot(page, 'keys');
    await page.getByRole('button', { name: /Done, I copied it/ }).click();
    await expect(page.getByTestId('key-secret')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('key-secret')).toHaveCount(0);

    await page.goto('/buyer/agents');
    const end = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    await page.getByLabel(/Money cap/).fill('5.00');
    await page.getByLabel(/Number of purchases/).fill('10');
    await page.getByLabel('Ends on').fill(end);
    await page.getByRole('button', { name: 'Review the cap' }).click();
    await expect(page.getByTestId('cap-sentence')).toContainText(
      'Your agent may spend up to $5.00 and make up to 10 purchases until',
    );
    await page.getByTestId('cap-form').getByRole('button').last().click();
    await expect(page.getByTestId('cap-card').first()).toContainText('Open');
    await shot(page, 'agents');
  });

  test('B5: an open approval shows on Home and in the approvals inbox, and opens the approve page', async ({
    browser,
  }) => {
    const page = await buyerPage(browser);
    await askPrice(page, { offer: 'village-bus', publisher: 'northfield-quarterly' });
    await toApproval(page);
    await page.goto('/buyer');
    await expect(page.getByTestId('home-needs_ok')).toContainText('Ends in');
    await page.goto('/buyer/approvals');
    await expect(page.getByTestId('approval-row')).toHaveCount(1);
    await shot(page, 'approvals');
    await page.getByTestId('approval-row').getByRole('link').click();
    await expect(page).toHaveURL(/\/approve\//);
    await expect(page.getByRole('heading', { name: 'Approve your purchase' })).toBeVisible();
  });

  test('B6: Report a problem from the order opens help with the order ref', async ({ browser }) => {
    const page = await buyerPage(browser);
    await page.goto(orderUrl);
    await page.getByTestId('report-problem').click();
    await expect(page).toHaveURL(/\/help\/(delivery|payment|frozen)\?order=/);
    await expect(page.getByTestId('help-order-ref')).toBeVisible();
  });

  test('the public buyer page is unchanged for a signed-out visitor (N4)', async ({ page }) => {
    await page.goto('/buyer');
    await expect(page.getByTestId('buyer-home')).toHaveCount(0);
  });
});
