// HARD-E2E: one dry-run purchase, followed to the places nothing else followed it to. Buyer A pays for a Quayside
// Gazette article to read online; the in-app reader opens and shows its paragraphs; then the publisher's sales page
// and statement carry the same amount as the receipt. Offline, dry run. The publisher figures are read before and
// after, so they hold whatever else has been bought. Buyer A has not touched this article in any other spec.
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { askPrice, buyerPage, toApproval, toDryRunCheckout } from './support';

const PUBLISHER_PASSCODE = 'e2e publisher passcode';
const TITLE = 'Why the quayside market moved indoors';

const minorOf = (text: string): number => Number(text.replace(/[^0-9]/g, ''));

async function publisherPage(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/signin?next=/publisher');
  await page.getByLabel('Who are you testing as?').selectOption('publisher-quayside-gazette');
  await page.getByLabel('Publisher passcode').fill(PUBLISHER_PASSCODE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Publisher home' })).toBeVisible();
  return { ctx, page };
}

/** Sales count and the Sales and Net lines of the USD block, in minor units; zero when there is no sale yet. */
async function figures(page: Page): Promise<{ count: number; sales: number; net: number }> {
  await page.goto('/publisher/sales');
  const counted = page.getByTestId('sales-count');
  const count =
    (await counted.count()) === 0
      ? 0
      : Number(/^(\d+) sale/.exec((await counted.innerText()).trim())?.[1] ?? '1');
  await page.goto('/publisher/statement');
  const block = page.getByTestId('statement-block').filter({ hasText: 'USD' });
  if ((await block.count()) === 0) return { count, sales: 0, net: 0 };
  const sales = minorOf(await block.locator('dt:text-is("Sales") + dd').innerText());
  const net = minorOf(await block.getByTestId('statement-net').innerText());
  return { count, sales, net };
}

test.describe.configure({ mode: 'serial' });

const seen = { orderRef6: '', priceMinor: 0, receiptTotal: '' };
let before = { count: 0, sales: 0, net: 0 };

test('an unpaid order says Not paid yet; then the buyer pays to read online; the receipt carries the quoted price; the reader shows the paragraphs', async ({
  browser,
}) => {
  const pub = await publisherPage(browser);
  before = await figures(pub.page);
  await pub.ctx.close();

  const page = await buyerPage(browser, 'a');
  await askPrice(page, {
    offer: 'market-hall-move',
    publisher: 'quayside-gazette',
    option: 'Read online',
  });
  const quote = (await page.getByTestId('quote-price').innerText()).trim();
  expect(quote).toMatch(/^\$\d+\.\d\d$/);
  seen.priceMinor = minorOf(quote);
  await toApproval(page);
  await expect(page.getByTestId('approve-total')).toHaveText(quote);
  await toDryRunCheckout(page);

  // The order now exists but nothing is paid (GATE35 D2): in a second tab the library says so in its own words,
  // with no receipt and no way in. (The same order is paid next; this spends no extra approval, which is
  // limited to 10 an hour for each buyer.)
  const lib = await page.context().newPage();
  await lib.goto('/library');
  const unpaid = lib.getByTestId('library-item').filter({ hasText: TITLE });
  await expect(unpaid).toHaveCount(1);
  await expect(unpaid.getByTestId('library-status')).toContainText('Not paid yet');
  await expect(unpaid.getByTestId('library-status')).not.toContainText(
    /Confirming|pending at PayPal/i,
  );
  await expect(unpaid.getByRole('button')).toHaveCount(0);
  await unpaid.getByRole('link', { name: TITLE }).click();
  await expect(lib.getByTestId('library-status')).toContainText(
    'Not paid yet. We have not received a payment for this order.',
  );
  await expect(lib.locator('dd', { hasText: /^Not paid yet$/ })).toBeVisible();
  await expect(lib.getByRole('link', { name: 'View receipt' })).toHaveCount(0);
  await expect(lib.getByRole('link', { name: 'Read here' })).toHaveCount(0);
  await lib.close();

  await page.getByLabel('What should the pretend payment do?').selectOption('happy');
  await page.getByRole('button', { name: 'Approve payment (dry run)' }).click();
  await expect(page).toHaveURL(/\/orders\//);
  seen.orderRef6 = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '').slice(
    -6,
  );
  await expect(page.getByTestId('order-live')).toContainText('Paid. Your item is in your library.');

  // The receipt: one line, and the total, both the quoted price.
  await page.getByRole('link', { name: 'View receipt' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Receipt/ })).toBeVisible();
  const line = page.getByTestId('receipt-line');
  await expect(line).toHaveCount(1);
  await expect(line).toContainText(TITLE);
  await expect(line).toContainText('Read online');
  await expect(line).toContainText(quote);
  const total = (await page.locator('main p', { hasText: 'Total:' }).innerText())
    .replace('Total:', '')
    .trim();
  expect(total).toBe(quote);
  seen.receiptTotal = total;

  // The library item opens in the reader.
  await page.goto('/library');
  const item = page.getByTestId('library-item').filter({ hasText: TITLE });
  await expect(item.getByTestId('library-status')).toContainText(/Ready/);
  await item.getByRole('link', { name: TITLE }).click();
  await page.getByRole('link', { name: 'Read here' }).click();
  await expect(page).toHaveURL(/\/library\/.+\/read$/);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
  await expect(page.getByTestId('env-label').first()).toContainText('Dry run');
  const paragraphs = page.getByTestId('reader-text').locator('p');
  await expect(paragraphs).toHaveCount(2);
  await expect(paragraphs.first()).toContainText('The market stood on the quay for ninety years.');
  await expect(paragraphs.nth(1)).toContainText('Traders report fewer lost days');
  await expect(page.getByTestId('reader-refusal')).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to this item' }).click();
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
  await page.context().close();
});

test('the publisher sales page lists the unit at the receipt amount', async ({ browser }) => {
  expect(seen.orderRef6).not.toBe('');
  const pub = await publisherPage(browser);
  const page = pub.page;
  await page.goto('/publisher/sales');
  await expect(page.getByTestId('sales-count')).toHaveText(
    `${String(before.count + 1)} ${before.count + 1 === 1 ? 'sale is' : 'sales are'} listed.`,
  );
  const row = page.locator(`#order-${seen.orderRef6}`);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(TITLE);
  await expect(row).toContainText('Read online');
  await expect(row).toContainText(seen.receiptTotal);
  await expect(row).toContainText('Not reported'); // a dry run reports no PayPal fee
  // No buyer is named anywhere on the page.
  await expect(page.locator('main')).not.toContainText(/buyer[- ]?[ab]\b/i);
  await pub.ctx.close();
});

test('the statement adds up to the same amount, and the ledger line links to the sale', async ({
  browser,
}) => {
  expect(seen.priceMinor).toBeGreaterThan(0);
  const pub = await publisherPage(browser);
  const page = pub.page;
  const after = await figures(page);
  expect(after.sales - before.sales).toBe(seen.priceMinor);
  expect(after.net - before.net).toBe(seen.priceMinor);

  const block = page.getByTestId('statement-block').filter({ hasText: 'USD' });
  await expect(block.getByRole('heading', { level: 2 })).toContainText('Dry run');
  await expect(block.getByTestId('settlement-sentence')).toContainText('Where the money is');
  const ledger = block.locator('tbody tr').filter({ hasText: seen.orderRef6 });
  await expect(ledger).toHaveCount(1);
  await expect(ledger).toContainText('Sale');
  await expect(ledger).toContainText(seen.receiptTotal);
  await ledger.getByRole('link', { name: seen.orderRef6 }).click();
  await expect(page).toHaveURL(new RegExp(`/publisher/sales#order-${seen.orderRef6}$`));
  await pub.ctx.close();
});
