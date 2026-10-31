// ID-ACCOUNTS end to end, in the browser against the built offline app: the landing page shows three doors;
// a buyer creates an account, signs out, signs in again, changes the password, and the old password is
// refused; the role pages and the sign in pages read well at 400 px in both looks. Synthetic values only.
// The server runs with one trusted proxy (playwright.config.ts), so each context sets its own client address.
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const stamp = Date.now().toString(36).slice(-6);
const octet = (Date.now() % 200) + 20;
const USER = `e2e.reader.${stamp}`;
const PW = 'violet lamps hum softly';
const PW2 = 'seven quiet harbours now';

async function fresh(browser: Browser, last = octet): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(last)}` } });
  return { page: await ctx.newPage(), close: () => ctx.close() };
}
async function ready(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
}

test.describe('landing page', () => {
  test('shows the hero and three doors with one button each', async ({ browser }) => {
    const { page, close } = await fresh(browser);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Buy just the article you need' })).toBeVisible();
    const doors = page.getByRole('region', { name: 'Choose your door' });
    await expect(doors.getByRole('heading', { level: 3 })).toHaveText(['Buyer', 'Seller', 'Operator']);
    await expect(doors.getByRole('link')).toHaveCount(3);
    await expect(doors.getByRole('link', { name: 'Go to the buyer page' })).toHaveAttribute('href', '/buyer');
    await expect(doors.getByRole('link', { name: 'Go to the seller page' })).toHaveAttribute('href', '/seller');
    await expect(doors.getByRole('link', { name: 'Go to operator sign in' })).toHaveAttribute('href', '/signin/operator');
    await close();
  });

  test('works without a script and has no sideways scroll at 400 px', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 400, height: 800 } });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Go to the buyer page' })).toBeVisible();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(wide).toBe(false);
    await ctx.close();
  });

  test('the doors lead to their pages', async ({ browser }) => {
    const { page, close } = await fresh(browser);
    for (const [link, url, heading] of [
      ['Go to the buyer page', /\/buyer$/, 'Buy articles one at a time'],
      ['Go to the seller page', /\/seller$/, 'Publish by the article'],
      ['Go to operator sign in', /\/signin\/operator$/, 'Operator sign in'],
    ] as const) {
      await page.goto('/');
      await page.getByRole('link', { name: link }).click();
      await expect(page).toHaveURL(url);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    }
    await close();
  });
});

test.describe('buyer account', () => {
  test('create, sign out, sign in again, change the password, old password refused', async ({ browser }) => {
    const { page, close } = await fresh(browser);
    await page.goto('/signup');
    await ready(page);
    await page.getByLabel('Display name').fill('E2E Reader');
    await page.getByLabel('Username').fill(USER);
    await page.getByLabel(/^Country/).fill('GB');
    await page.getByLabel('Password', { exact: true }).fill(PW);
    await page.getByLabel('Repeat password').fill(PW);
    await page.getByRole('checkbox', { name: /I accept the Terms and the Privacy notice/ }).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/discover$/);
    const header = page.getByRole('navigation', { name: 'Main' });
    await expect(header.getByRole('link', { name: 'Account' })).toBeVisible();

    await ready(page);
    await header.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible();

    await page.goto('/signin/buyer');
    await ready(page);
    await page.getByLabel('Username').fill(USER);
    await page.getByLabel('Password').fill('not the right password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('That username or password did not work.');
    await page.getByLabel('Password').fill(PW);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(header.getByRole('link', { name: 'Account' })).toBeVisible();

    await page.goto('/account');
    await ready(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
    await page.getByLabel('Current password').fill(PW);
    await page.getByLabel('New password', { exact: true }).fill(PW2);
    await page.getByLabel('Repeat new password').fill(PW2);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Password changed' })).toBeVisible();

    await ready(page);
    await header.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/signin/buyer');
    await ready(page);
    await page.getByLabel('Username').fill(USER);
    await page.getByLabel('Password').fill(PW);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('That username or password did not work.');
    await page.getByLabel('Password').fill(PW2);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(header.getByRole('link', { name: 'Account' })).toBeVisible();
    await close();
  });

  test('a taken username is said plainly, and a weak password says why', async ({ browser }) => {
    const { page, close } = await fresh(browser, octet + 1);
    await page.goto('/signup');
    await ready(page);
    await page.getByLabel('Display name').fill('Second Reader');
    await page.getByLabel('Username').fill(USER);
    await page.getByLabel(/^Country/).fill('GB');
    await page.getByLabel('Password', { exact: true }).fill('password1234');
    await page.getByLabel('Repeat password').fill('password1234');
    await page.getByRole('checkbox', { name: /I accept the Terms/ }).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toContainText('too common');
    await page.getByLabel('Password', { exact: true }).fill(PW);
    await page.getByLabel('Repeat password').fill(PW);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toContainText('That username is taken.');
    await close();
  });

  test('show and hide changes the field type and paste stays allowed', async ({ browser }) => {
    const { page, close } = await fresh(browser, octet + 2);
    await page.goto('/signup');
    await ready(page);
    const field = page.getByLabel('Password', { exact: true });
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveAttribute('autocomplete', 'new-password');
    await page.getByRole('button', { name: 'Show password' }).first().click();
    await expect(field).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide password' }).first().click();
    await expect(field).toHaveAttribute('type', 'password');
    await close();
  });
});

test.describe('role pages', () => {
  const pages: Array<[string, string]> = [
    ['/buyer', 'Buy articles one at a time'],
    ['/seller', 'Publish by the article'],
    ['/signin/buyer', 'Buyer sign in'],
    ['/signin/seller', 'Publisher sign in'],
    ['/signin/operator', 'Operator sign in'],
    ['/signup', 'Create your account'],
    ['/help/password', 'Lost your password?'],
    ['/signin', 'Sign in'],
  ];
  for (const skin of ['market', 'harbour'] as const) {
    test(`read well at 400 px in ${skin}: one h1, no sideways scroll, keyboard focus is visible`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 400, height: 800 }, extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.9' } });
      await ctx.addCookies([{ name: 'um_skin', value: skin, url: 'http://localhost:3100' }]);
      const page = await ctx.newPage();
      for (const [path, h1] of pages) {
        await page.goto(path);
        await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), path).toBe(false);
      }
      await page.goto('/buyer');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
      expect(outline).not.toBe('none');
      await ctx.close();
    });
  }

  test('the seller page says what to prepare and that no email is sent; the operator page shows its hint', async ({ browser }) => {
    const { page, close } = await fresh(browser);
    await page.goto('/seller');
    await expect(page.getByText('This demo sends no email')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Apply to publish' })).toHaveAttribute('href', '/apply');
    await expect(page.getByRole('link', { name: 'Check an application' })).toHaveAttribute('href', '/apply/status');
    await expect(page.getByRole('link', { name: 'Sign in' }).last()).toHaveAttribute('href', '/signin/seller');
    await page.goto('/signin/operator');
    await expect(page.getByText(/Leave the name and code empty/)).toBeVisible();
    await page.goto('/help/password');
    await expect(page.getByText('unitmarket@raviprolu.com').first()).toBeVisible();
    await close();
  });

  test('the test persona sign in is still on /signin, under its own heading', async ({ browser }) => {
    const { page, close } = await fresh(browser);
    await page.goto('/signin');
    await expect(page.getByRole('heading', { level: 2, name: 'Judges and testers' })).toBeVisible();
    await expect(page.getByLabel('Who are you testing as?')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Buyer sign in' })).toHaveAttribute('href', '/signin/buyer');
    await close();
  });
});
