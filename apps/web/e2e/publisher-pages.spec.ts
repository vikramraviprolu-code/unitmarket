// HARD-E2E: the publisher area as a publisher walks it, offline and dry run, read only. Sign in with the publisher
// passcode, the publisher home and its four links, the offers list, and sign out. Nothing here changes a stored
// record, so the order of the files does not matter.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const PUBLISHER_PASSCODE = 'e2e publisher passcode';

async function signInPublisher(page: Page, persona: string): Promise<void> {
  await page.goto('/signin?next=/publisher');
  await page.getByLabel('Who are you testing as?').selectOption(persona);
  await page.getByLabel('Publisher passcode').fill(PUBLISHER_PASSCODE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Publisher home' })).toBeVisible();
}

test('the publisher home shows the signed in publisher only, from stored data', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInPublisher(page, 'publisher-harbour-ledger');
  await expect(page.getByTestId('publisher-name')).toHaveText('Harbour Ledger Review (fictional)');
  await expect(page.getByTestId('publisher-status')).toHaveText('Active');
  await expect(page.getByTestId('publisher-offers')).toHaveText(/^\d+ offers? (is|are) live\.$/);
  await expect(page.getByTestId('publisher-payee')).toContainText('Account ending');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Publisher' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Find articles' })).toHaveCount(0);
  await expect(page.getByTestId('env-label').first()).toContainText('Dry run');
  await ctx.close();
});

test('the four links on the publisher home open their pages and a way back', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInPublisher(page, 'publisher-harbour-ledger');
  const links = page.getByTestId('publisher-links');
  await expect(links.getByRole('link')).toHaveCount(4);
  const pages = [
    { link: 'Your offers', url: /\/publisher\/offers$/, heading: /^Your offers/ },
    { link: 'Sales', url: /\/publisher\/sales$/, heading: /^Sales/ },
    { link: 'Statement', url: /\/publisher\/statement$/, heading: /^Statement$/ },
    {
      link: 'Where you get paid',
      url: /\/publisher\/payout-account$/,
      heading: /^Where you get paid/,
    },
  ];
  for (const p of pages) {
    await page.goto('/publisher');
    await page
      .getByTestId('publisher-links')
      .getByRole('link', { name: p.link, exact: true })
      .click();
    await expect(page).toHaveURL(p.url);
    await expect(page.getByRole('heading', { level: 1, name: p.heading })).toBeVisible();
    await expect(page.getByTestId('env-label').first()).toContainText('Dry run');
  }
  await ctx.close();
});

test('the offers list shows only this publisher, each with prices, a status and a change link', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInPublisher(page, 'publisher-harbour-ledger');
  await page.goto('/publisher/offers');
  const rows = page.getByTestId('offer-row');
  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasText: 'On sale' }).first()).toContainText('Download and keep: $');
  await expect(rows.filter({ hasText: 'On sale' }).first()).toContainText('Read online: $');
  // Another publisher's articles are not listed here.
  await expect(page.locator('main')).not.toContainText('Why the quayside market moved indoors');
  await expect(page.locator('main')).not.toContainText('Northfield');
  const change = rows.first().getByRole('link', { name: /^Change / });
  await change.click();
  await expect(page).toHaveURL(/\/publisher\/offers\/.+/);
  await expect(page.getByTestId('offer-version')).toBeVisible();
  await expect(page.getByTestId('offer-currency')).toHaveText('USD');
  await expect(page.getByRole('link', { name: 'Back to your offers' })).toBeVisible();
  await ctx.close();
});

test('a publisher cannot reach another publisher’s offer by its address', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInPublisher(page, 'publisher-quayside-gazette');
  await page.goto('/publisher/offers');
  const quayside = await page
    .getByTestId('offer-row')
    .first()
    .getByRole('link', { name: /^Change / })
    .getAttribute('href');
  expect(quayside).toMatch(/^\/publisher\/offers\//);
  await ctx.close();

  const other = await browser.newContext();
  const harbour = await other.newPage();
  await signInPublisher(harbour, 'publisher-harbour-ledger');
  const res = await harbour.goto(quayside ?? '/');
  expect(res?.status()).toBe(404);
  await other.close();
});

test('a publisher signs out: the header goes back to Sign in and the publisher pages close', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInPublisher(page, 'publisher-northfield-quarterly');
  await page.waitForLoadState('networkidle');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Sign out' })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sign in' }),
  ).toBeVisible();
  for (const path of ['/publisher', '/publisher/sales', '/publisher/statement']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/signin/);
  }
  await ctx.close();
});
