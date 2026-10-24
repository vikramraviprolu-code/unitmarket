import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

export const PASSCODE = 'e2e passcode one';
// The fixed fake operator key the e2e server is started with (playwright.config.ts): the RFC 6238
// test key "12345678901234567890". A public test value, not a credential.
export const TOTP_KEY_BYTES = Buffer.from('12345678901234567890', 'ascii');
const dir = fileURLToPath(new URL('./.auth/', import.meta.url));
export const AUTH_A = `${dir}buyer-a.json`;
export const AUTH_B = `${dir}buyer-b.json`;
const csrfOf = (auth: string): string => auth.replace(/\.json$/, '.csrf');

/**
 * A page signed in as buyer A (or B, who owns nothing yet) through the session saved by the setup
 * project (one passcode attempt per buyer for the whole run).
 */
export async function buyerPage(browser: Browser, who: 'a' | 'b' = 'a'): Promise<Page> {
  const auth = who === 'a' ? AUTH_A : AUTH_B;
  const ctx = await browser.newContext({ storageState: auth });
  const csrf = readFileSync(csrfOf(auth), 'utf8');
  await ctx.addInitScript((token) => {
    window.sessionStorage.setItem('um_csrf', token);
  }, csrf);
  return ctx.newPage();
}

export async function expectDryRun(page: Page): Promise<void> {
  await expect(page.getByTestId('env-label').first()).toContainText('Dry run');
}

/** Offer page: pick an option, optionally a ceiling, ask for the price. */
export async function askPrice(
  page: Page,
  o: { offer?: string; ceiling?: string; option?: 'Read online' | 'Download and keep' } = {},
): Promise<void> {
  await page.goto(`/o/harbour-ledger/${o.offer ?? 'tide-tables'}`);
  await page
    .getByLabel(o.option ?? 'Read online', { exact: false })
    .first()
    .check();
  if (o.ceiling !== undefined) await page.getByLabel(/Your ceiling/).fill(o.ceiling);
  await page.getByRole('button', { name: 'Show my price' }).click();
}

/** From a shown quote: accept terms and go to the approval screen. */
export async function toApproval(page: Page): Promise<void> {
  await page.getByLabel('I accept the terms of this purchase.').check();
  await page.getByRole('button', { name: 'Review and approve' }).click();
  await expect(page).toHaveURL(/\/approve\//);
}

/** Approval screen to the dry-run checkout page: confirm, continue to payment. */
export async function toDryRunCheckout(page: Page): Promise<void> {
  await page.getByLabel(/I confirm the price and terms above/).check();
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await expect(page).toHaveURL(/\/checkout\/dry-run\//);
  await expect(page.getByRole('heading', { name: 'Dry run: no PayPal' }).first()).toBeVisible();
}

/**
 * The whole buyer journey up to the order page: offer, price, terms, approval, dry-run checkout
 * with the chosen pretend payment outcome, return. Each journey uses its own offer, because one
 * buyer cannot hold two open orders for the same article.
 */
export async function payWithScenario(
  page: Page,
  o: { offer: string; scenario: string; option?: 'Read online' | 'Download and keep' },
): Promise<void> {
  await askPrice(page, { offer: o.offer, ...(o.option === undefined ? {} : { option: o.option }) });
  await toApproval(page);
  await toDryRunCheckout(page);
  await page.getByLabel('What should the pretend payment do?').selectOption(o.scenario);
  await page.getByRole('button', { name: 'Approve payment (dry run)' }).click();
  await expect(page).toHaveURL(/\/orders\//);
}
