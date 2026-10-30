// HARD-E2E: a publisher changes an offer and takes one off sale, and a buyer sees both. Offline, dry run. It
// changes a shared record, so it runs after zcomposite.spec.ts (which buys these articles) and before
// zz-ops-stop.spec.ts. The offer is Quayside Gazette's walk along the old quay; no later spec needs it.
// The buyer sees the new price on the offer page. (A buyer who already holds the article gets a quote of
// "already in your library", which is why the price is read from the page, not from a quote.)
import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { buyerPage } from './support';

const PUBLISHER_PASSCODE = 'e2e publisher passcode';
const TITLE = 'A morning walk along the old quay';
const OFFER_PAGE = '/o/quayside-gazette/quay-walk';

test.describe.configure({ mode: 'serial' });

let ctx: BrowserContext;
let page: Page;
let offerHref = '';
let firstVersion = '';

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.goto('/signin?next=/publisher/offers');
  await page.getByLabel('Who are you testing as?').selectOption('publisher-quayside-gazette');
  await page.getByLabel('Publisher passcode').fill(PUBLISHER_PASSCODE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Your offers/ })).toBeVisible();
});

test.afterAll(async () => {
  await ctx.close();
});

test('revise: the new price is saved as a new version and the buyer sees it', async ({
  browser,
}) => {
  const row = page.getByTestId('offer-row').filter({ hasText: TITLE });
  await expect(row).toContainText('On sale');
  await expect(row).toContainText('Read online: $1.00');
  offerHref = (await row.getByRole('link', { name: `Change ${TITLE}` }).getAttribute('href')) ?? '';
  await page.goto(offerHref);
  await page.waitForLoadState('networkidle');
  firstVersion = (await page.getByTestId('offer-version').innerText()).trim();
  await expect(page.getByTestId('offer-status')).toHaveText('On sale');

  // Saving needs the rights confirmation.
  const save = page.getByRole('button', { name: 'Save as new version' });
  await expect(save).toBeDisabled();
  await page.getByLabel('Price for Read online (USD)').fill('1.75');
  await page.getByLabel(/I confirm that I hold the rights/).check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByTestId('offer-save-result')).toContainText('Saved. This is now version');
  await expect(page.getByTestId('offer-version')).not.toHaveText(firstVersion);
  await expect(page.getByTestId('offer-history')).toContainText('Read online $1.75');
  await expect(page.getByTestId('offer-history')).toContainText('Read online $1.00');

  // The list shows the new price; the other option is unchanged.
  await page.goto('/publisher/offers');
  const row2 = page.getByTestId('offer-row').filter({ hasText: TITLE });
  await expect(row2).toContainText('Read online: $1.75');
  await expect(row2).toContainText('Download and keep: $1.00');

  // The buyer sees it on the offer page.
  const buyer = await buyerPage(browser, 'a');
  await buyer.goto(OFFER_PAGE);
  await expect(buyer.getByRole('radio', { name: /Read online/ })).toBeVisible();
  await expect(buyer.locator('main')).toContainText('Read online: $1.75');
  await expect(buyer.locator('main')).toContainText('Download and keep: $1.00');
  await buyer.context().close();
});

test('withdraw: the offer goes off sale, the publisher cannot change it, and the buyer gets no match', async ({
  browser,
}) => {
  await page.goto(offerHref);
  await page.waitForLoadState('networkidle');
  const withdraw = page.getByRole('button', { name: 'Withdraw this offer' });
  await expect(withdraw).toBeDisabled();
  await page.getByLabel('Why are you withdrawing it?').fill('e2e withdraw drill');
  await withdraw.click();
  await expect(page.getByTestId('offer-withdraw-result')).toHaveText(
    'Withdrawn. New buyers will not find this offer.',
  );
  await expect(page.getByTestId('offer-status')).toHaveText('Withdrawn');
  await expect(page.getByTestId('offer-withdrawn-notice')).toHaveText(
    'This offer is withdrawn. It cannot be changed here.',
  );
  await expect(page.getByRole('button', { name: 'Save as new version' })).toHaveCount(0);
  await page.goto('/publisher/offers');
  await expect(page.getByTestId('offer-row').filter({ hasText: TITLE })).toContainText('Withdrawn');

  const buyer = await buyerPage(browser, 'a');
  await buyer.goto(OFFER_PAGE);
  await buyer.waitForLoadState('networkidle');
  await buyer.getByRole('button', { name: 'Show my price' }).click();
  const result = buyer.getByTestId('quote-result');
  await expect(result).toContainText('No match');
  await expect(result).toContainText('The publisher has withdrawn this offer.');
  await expect(buyer.getByRole('button', { name: 'Review and approve' })).toHaveCount(0);
  await buyer.context().close();
});
