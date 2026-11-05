// INT-SEL / SEL.9: the five seller journeys, offline and dry run, read only. The file name puts it after
// refund.spec.ts, which has already made sales for Harbour Ledger. Nothing here changes a stored record.
//   S1  Home: setup path or this week, top offers, agent share; the tabs open
//   S2  Sales: All, Pending and Refunds; open a sale; the sale page names no buyer
//   S3  Sales export: the CSV has no buyer column
//   S4  Money: the statement, "modelled" on the dry run block, the PUB-E1 download
//   S5  Offers: the list, an offer page with price history and sales; another seller's sale is a 404
// The agent order with a canary total is proven in seller-sale.adversarial.test.ts; the e2e demo data has no
// agent order, so here the page is scanned for the demo buyers' names and ids.
import { mkdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const PUBLISHER_PASSCODE = 'e2e publisher passcode';
const SHOTS = new URL('../test-results/shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

async function signInSeller(browser: Browser, persona: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/signin?next=/publisher');
  await page.getByLabel('Who are you testing as?').selectOption(persona);
  await page.getByLabel('Publisher passcode').fill(PUBLISHER_PASSCODE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('publisher-name')).toBeVisible();
  return page;
}

const NEVER = [
  'Buyer A',
  'Buyer B',
  'buy_persona',
  'order_total',
  'agent_key',
  'mandate',
  'req_id',
  'ip_hash',
];

let harbour: Page;
let quayside: Page;
let saleHref = '';

test.beforeAll(async ({ browser }) => {
  harbour = await signInSeller(browser, 'publisher-harbour-ledger');
  quayside = await signInSeller(browser, 'publisher-quayside-gazette');
});
test.afterAll(async () => {
  await harbour.context().close();
  await quayside.context().close();
});

test('S1 Home shows the seller figures in words and the tabs open', async ({ baseURL }) => {
  await harbour.goto('/publisher');
  await expect(harbour.getByTestId('seller-week')).toBeVisible();
  await expect(harbour.getByTestId('seller-agent-share')).toBeVisible();
  await expect(harbour.getByTestId('seller-top-offers')).toBeVisible();
  const text = await harbour.getByTestId('seller-week').innerText();
  expect(text).not.toMatch(/NaN|undefined/);
  const nav = harbour.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Seller' })).toBeVisible();
  for (const [path, name] of [
    ['/publisher/offers', /^Your offers/],
    ['/publisher/sales', /^Sales/],
    ['/publisher/statement', /^Statement$/],
    ['/publisher/payout-account', /^Where you get paid/],
  ] as const) {
    await harbour.goto(path);
    await expect(harbour.getByRole('heading', { level: 1, name })).toBeVisible();
  }
  for (const skin of ['market', 'harbour']) {
    await harbour
      .context()
      .addCookies([{ name: 'um_skin', value: skin, url: baseURL ?? 'http://localhost:3100' }]);
    await harbour.goto('/publisher');
    await harbour.screenshot({ path: `${SHOTS}sel-home-${skin}.png`, fullPage: true });
  }
});

test('S2 Sales has three views, and a sale opens on a page with no buyer on it', async ({
  baseURL,
}) => {
  await harbour.goto('/publisher/sales');
  const tabs = harbour.getByRole('navigation', { name: 'Sales views' });
  for (const name of [/^All \(\d+\)/, /^Pending \(\d+\)/, /^Refunds \(\d+\)/])
    await expect(tabs.getByRole('link', { name })).toBeVisible();
  const first = harbour
    .getByTestId('sales-table')
    .getByRole('link', { name: /Open sale/ })
    .first();
  await expect(first).toBeVisible();
  saleHref = (await first.getAttribute('href')) ?? '';
  expect(saleHref).toMatch(/^\/publisher\/sales\/[^/]+$/);
  await first.click();
  await expect(harbour.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(harbour.getByTestId('sale-bought-by')).toHaveText(/^(a person|an agent)$/);
  await expect(harbour.getByTestId('sale-net')).toBeVisible();
  const html = await harbour.content();
  for (const bad of NEVER) expect(html, bad).not.toContain(bad);
  for (const skin of ['market', 'harbour']) {
    await harbour
      .context()
      .addCookies([{ name: 'um_skin', value: skin, url: baseURL ?? 'http://localhost:3100' }]);
    await harbour.goto(saleHref);
    await harbour.screenshot({ path: `${SHOTS}sel-sale-${skin}.png`, fullPage: true });
    await harbour.goto('/publisher/sales');
    await harbour.screenshot({ path: `${SHOTS}sel-sales-${skin}.png`, fullPage: true });
  }
});

test('S3 the Sales CSV has no buyer column and no order total', async () => {
  const res = await harbour.request.get('/api/publisher/sales/export');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { filename: string; csv: string };
  expect(body.filename).toMatch(/^sales-\d{4}-\d{2}-\d{2}\.csv$/);
  const header = body.csv.split('\r\n')[0]!;
  for (const bad of ['buyer', 'agent', 'mandate', 'order_total', 'reason'])
    expect(header, bad).not.toContain(bad);
  for (const bad of NEVER) expect(body.csv, bad).not.toContain(bad);
  const refused = await harbour.request.get('/api/publisher/sales/export?buyer=x');
  expect(refused.status()).toBe(400);
});

test('S4 Money shows the statement and says "modelled" on the dry run block', async ({
  baseURL,
}) => {
  await harbour.goto('/publisher/statement');
  await expect(harbour.getByTestId('statement-block').first()).toBeVisible();
  await expect(harbour.getByTestId('statement-modelled').first()).toHaveText('modelled');
  await expect(harbour.getByTestId('export-statement')).toBeVisible();
  for (const skin of ['market', 'harbour']) {
    await harbour
      .context()
      .addCookies([{ name: 'um_skin', value: skin, url: baseURL ?? 'http://localhost:3100' }]);
    await harbour.goto('/publisher/statement');
    await harbour.screenshot({ path: `${SHOTS}sel-money-${skin}.png`, fullPage: true });
  }
});

test('S5 an offer page has price history and sales, and another seller cannot open a sale', async ({
  baseURL,
}) => {
  await harbour.goto('/publisher/offers');
  await harbour
    .getByRole('link', { name: /Edit|View/ })
    .first()
    .click();
  await expect(harbour.getByTestId('offer-history')).toBeVisible();
  await expect(harbour.getByTestId('offer-sales')).toBeVisible();
  const res = await quayside.goto(saleHref);
  expect(res?.status()).toBe(404);
  const unknown = await quayside.goto('/publisher/sales/unt_does_not_exist');
  expect(unknown?.status()).toBe(404);
  expect(await quayside.content()).toBe(
    await (async () => {
      await quayside.goto(saleHref);
      return quayside.content();
    })(),
  );
  for (const skin of ['market', 'harbour']) {
    await harbour
      .context()
      .addCookies([{ name: 'um_skin', value: skin, url: baseURL ?? 'http://localhost:3100' }]);
    await harbour.goto('/publisher/offers');
    await harbour.screenshot({ path: `${SHOTS}sel-offers-${skin}.png`, fullPage: true });
  }
});
