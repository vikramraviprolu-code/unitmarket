// HARD-E2E: the publisher passcode and the judge passcode, in the browser. The publisher passcode opens a
// publisher persona and nothing else; the demo and judge passcodes do not open a publisher. The judge passcode
// signs a buyer in and never the operator or a publisher. The passcodes are synthetic test values from
// playwright.config.ts, not secrets. A refused sign-in spends one token of the persona's bucket (5 per 15
// minutes) and a good one gives them back, so each persona here has at most two refusals before a success.
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { PASSCODE } from './support';

const PUBLISHER_PASSCODE = 'e2e publisher passcode';
const JUDGE_PASSCODE = 'e2e judge passcode';
const REFUSED = 'That passcode did not work. Check it and try again.';

async function fresh(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  return { page: await ctx.newPage(), close: () => ctx.close() };
}

async function signIn(
  page: Page,
  persona: string,
  passcodeLabel: string,
  passcode: string,
  next: string,
) {
  await page.goto(`/signin?next=${next}`);
  await page.getByLabel('Who are you testing as?').selectOption(persona);
  await page.getByLabel(passcodeLabel).fill(passcode);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('publisher passcode', () => {
  test('opens the publisher home, as that publisher only', async ({ browser }) => {
    const { page, close } = await fresh(browser);
    await signIn(
      page,
      'publisher-harbour-ledger',
      'Publisher passcode',
      PUBLISHER_PASSCODE,
      '/publisher',
    );
    await expect(page.getByTestId('publisher-name')).toBeVisible();
    await expect(page.getByTestId('publisher-name')).toHaveText(
      'Harbour Ledger Review (fictional)',
    );
    // A publisher has no buyer pages: the library and discovery send them elsewhere.
    await page.goto('/library');
    await expect(page).toHaveURL(/\/signin\?next=(%2F|\/)library$/);
    await close();
  });

  test('the sign-in form says the demo passcode does not work for a publisher, and refuses it', async ({
    browser,
  }) => {
    const { page, close } = await fresh(browser);
    await page.goto('/signin?next=/publisher');
    await page.getByLabel('Who are you testing as?').selectOption('publisher-quayside-gazette');
    await expect(page.getByText('The demo passcode does not work for publishers.')).toBeVisible();
    await page.getByLabel('Publisher passcode').fill(PASSCODE);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(REFUSED)).toBeVisible();
    await expect(page).toHaveURL(/\/signin/);
    await close();
  });

  test('the judge passcode does not open a publisher', async ({ browser }) => {
    const { page, close } = await fresh(browser);
    await signIn(
      page,
      'publisher-northfield-quarterly',
      'Publisher passcode',
      JUDGE_PASSCODE,
      '/publisher',
    );
    await expect(page.getByText(REFUSED)).toBeVisible();
    await expect(page).toHaveURL(/\/signin/);
    // Still signed out: the publisher home sends the visitor to sign in.
    await page.goto('/publisher');
    await expect(page).toHaveURL(/\/signin\?next=(%2F|\/)publisher$/);
    await close();
  });

  test('the publisher passcode does not open a buyer or the operator', async ({ browser }) => {
    const buyer = await fresh(browser);
    await signIn(buyer.page, 'buyer-a', 'Demo passcode', PUBLISHER_PASSCODE, '/library');
    await expect(buyer.page.getByText(REFUSED)).toBeVisible();
    await expect(buyer.page).toHaveURL(/\/signin/);
    await buyer.close();

    const op = await fresh(browser);
    await signIn(op.page, 'operator', 'Demo passcode', PUBLISHER_PASSCODE, '/ops');
    await expect(
      op.page.getByText(
        'That did not work. Check the passcode, your name and the current code, then try again.',
      ),
    ).toBeVisible();
    await expect(op.page).toHaveURL(/\/signin/);
    await op.close();
  });
});

test.describe('judge passcode', () => {
  test('signs a buyer in, and that buyer is an ordinary buyer', async ({ browser }) => {
    const { page, close } = await fresh(browser);
    await signIn(page, 'buyer-a', 'Demo passcode', JUDGE_PASSCODE, '/library');
    await expect(page.getByRole('heading', { level: 1, name: 'My library' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Find articles' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Operations' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Seller' })).toHaveCount(0);
    // A buyer session is not an operator or publisher one.
    await page.goto('/ops');
    await expect(page).toHaveURL(/\/signin/);
    await page.goto('/publisher');
    await expect(page).toHaveURL(/\/signin/);
    await close();
  });

  test('does not sign the operator in, with or without a name and a code', async ({ browser }) => {
    const { page, close } = await fresh(browser);
    await page.goto('/signin?next=/ops');
    await page.getByLabel('Who are you testing as?').selectOption('operator');
    await page.getByLabel('Demo passcode').fill(JUDGE_PASSCODE);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(
      page.getByText(
        'That did not work. Check the passcode, your name and the current code, then try again.',
      ),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/signin/);
    await page.goto('/ops');
    await expect(page).toHaveURL(/\/signin/);
    await close();
  });
});
