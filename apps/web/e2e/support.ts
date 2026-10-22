import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

export const PASSCODE = 'e2e passcode one';
const dir = fileURLToPath(new URL('./.auth/', import.meta.url));
export const AUTH_A = `${dir}buyer-a.json`;
const CSRF_A = `${dir}buyer-a.csrf`;

/** A page signed in as buyer A through the saved session (one passcode attempt for the whole run). */
export async function buyerPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ storageState: AUTH_A });
  const csrf = readFileSync(CSRF_A, 'utf8');
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
