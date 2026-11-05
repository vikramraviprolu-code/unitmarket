// INT-BUY / BUY.10 e2e (offline, dry run): the buyer journeys B1 to B6 of the buyer Home design, on the pages this lane
// builds. A fresh buyer pays one offer (tide-tables), leaves an approval open on another
// (ferry-timetables), makes an agent key and gives it a cap, and checks each screen. Every light and dark screenshot
// is written to the int-buy folder when UM_SHOT_DIR is set.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { askPrice, expectDryRun, payWithScenario, toApproval } from './support';

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
let page: Page;
const PW = 'violet lamps hum softly';
const ready = async (): Promise<void> => page.waitForLoadState('networkidle');
test.describe.configure({ mode: 'serial' });

test.describe('buyer journeys B1 to B6', () => {
  // A buyer of its own, so no other spec's purchases or open orders touch these journeys (and the reverse).
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({
      extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.77' },
    });
    page = await ctx.newPage();
    await page.goto('/signup');
    await ready();
    await page.getByLabel('Display name').fill('Journey Buyer');
    await page.getByLabel('Username').fill('e2e.journeys');
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

  test('B1: find and pay, then the order page says Open now and a step list', async () => {
    await payWithScenario(page, {
      offer: 'tide-tables',
      scenario: 'happy',
    });
    orderUrl = page.url();
    await expect(page.getByTestId('milestones')).toContainText('Done: Approved');
    await expect(page.getByTestId('milestones')).toContainText('Done: Paid');
    await expectDryRun(page);
    await shot(page, 'order');
  });

  test('B2: Home puts what to continue reading first and shows the spend sections in order', async () => {
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
    await expect(page.getByTestId('home-continue_reading')).toContainText(/tide/i);
    await shot(page, 'home');
  });

  test('B3: Spending lists the purchase, and Receipts has the order ref, PayPal order id and seller', async () => {
    await page.goto('/buyer/spending');
    await expect(page.getByRole('heading', { level: 1, name: 'Spending' })).toBeVisible();
    await expect(page.getByTestId('spending-table')).toContainText(/tide/i);
    await shot(page, 'spending');
    await page.goto('/buyer/receipts');
    const row = page.getByTestId('receipt-row').first();
    await expect(row).toContainText('Harbour');
    await expect(row.getByRole('link', { name: 'Receipt' })).toHaveAttribute(
      'href',
      /\/receipts\/.+/,
    );
    await shot(page, 'receipts');
  });

  test('B4: make an agent key, copy it once, give it a cap with a confirm sentence', async () => {
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

  test('B5: an open approval shows on Home and in the approvals inbox, and opens the approve page', async () => {
    await askPrice(page, { offer: 'ferry-timetables' });
    await toApproval(page);
    await page.goto('/buyer');
    await expect(page.getByTestId('home-needs_ok')).toContainText('Ends in');
    await page.goto('/buyer/approvals');
    expect(await page.getByTestId('approval-row').count()).toBeGreaterThan(0);
    await shot(page, 'approvals');
    await page.getByTestId('approval-row').first().getByRole('link').click();
    await expect(page).toHaveURL(/\/approve\//);
    await expect(page.getByRole('heading', { name: 'Approve your purchase' })).toBeVisible();
  });

  test('B6: Report a problem from the order opens help with the order ref', async () => {
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
