// HARD-E2E: the parts of the shell no earlier journey touched. The four legal pages and the footer links
// to them, the Appearance control (the choice sticks across a reload and sets the data-skin attribute), and
// sign out. Offline, dry run, no purchase; every test uses its own browser context, so no state is shared.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { PASSCODE } from './support';

const LEGAL = [
  { slug: 'terms', link: 'Terms of purchase', title: 'Terms of purchase' },
  { slug: 'privacy', link: 'Privacy notice', title: 'Privacy notice' },
  { slug: 'refunds', link: 'Refund policy', title: 'Refund policy' },
  {
    slug: 'publisher-terms',
    link: 'Publisher terms',
    title: 'Publisher terms and sandbox disclaimer',
  },
] as const;

/** Pages hydrate after first paint: a click before that is lost. Wait for the network to settle first. */
async function ready(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
}

test.describe('legal pages (LEGAL-A)', () => {
  for (const doc of LEGAL) {
    test(`/legal/${doc.slug} shows its title, the draft banner and the sandbox line`, async ({
      page,
    }) => {
      const res = await page.goto(`/legal/${doc.slug}`);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1, name: doc.title })).toBeVisible();
      const banner = page.getByTestId('legal-banner');
      await expect(banner).toContainText(
        'Final terms for this sandbox demo. This is not legal advice.',
      );
      await expect(banner).toContainText('This is a test build. No real money moves.');
      // The page is real text, not an empty shell.
      expect(
        ((await page.getByTestId(`legal-${doc.slug}`).innerText()) ?? '').length,
      ).toBeGreaterThan(400);
    });
  }

  test('the footer carries all four legal links, signed out, and each one opens its page', async ({
    page,
  }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Legal' });
    await expect(nav.getByRole('link')).toHaveCount(4);
    for (const doc of LEGAL) {
      await page.goto('/');
      await page
        .getByRole('navigation', { name: 'Legal' })
        .getByRole('link', { name: doc.link })
        .click();
      await expect(page).toHaveURL(new RegExp(`/legal/${doc.slug}$`));
      await expect(page.getByRole('heading', { level: 1, name: doc.title })).toBeVisible();
      // The footer is on the legal page too, so a reader can go on to the next one.
      await expect(page.getByRole('navigation', { name: 'Legal' }).getByRole('link')).toHaveCount(
        4,
      );
    }
  });

  test('the sign-in page links to the privacy notice', async ({ page }) => {
    await page.goto('/signin');
    await page
      .getByTestId('signin-privacy')
      .getByRole('link', { name: 'the privacy notice' })
      .click();
    await expect(page).toHaveURL(/\/legal\/privacy$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy notice' })).toBeVisible();
  });
});

test.describe('Appearance control (SKIN-A)', () => {
  test('starts on Bright Market, switches to Deep Harbour and keeps the choice across a reload', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/');
    await ready(page);
    const html = page.locator('html');
    const appearance = page.getByTestId('appearance');
    await expect(html).toHaveAttribute('data-skin', 'market');
    await expect(appearance.getByRole('radio', { name: 'Bright Market' })).toBeChecked();
    await expect(appearance.getByRole('radio', { name: 'Deep Harbour' })).not.toBeChecked();

    await appearance.getByRole('radio', { name: 'Deep Harbour' }).check();
    await expect(html).toHaveAttribute('data-skin', 'harbour');
    await expect(page.getByTestId('appearance-status')).toHaveText(
      'Appearance changed to Deep Harbour.',
    );

    // The cookie holds the skin name and nothing else, and the server renders it on first paint.
    const cookie = (await ctx.cookies()).find((c) => c.name === 'um_skin');
    expect(cookie?.value).toBe('harbour');
    await page.reload();
    await expect(html).toHaveAttribute('data-skin', 'harbour');
    await expect(appearance.getByRole('radio', { name: 'Deep Harbour' })).toBeChecked();
    // It sticks on another page too.
    await page.goto('/legal/terms');
    await expect(html).toHaveAttribute('data-skin', 'harbour');

    // And back again.
    await page.goto('/');
    await ready(page);
    await appearance.getByRole('radio', { name: 'Bright Market' }).check();
    await expect(html).toHaveAttribute('data-skin', 'market');
    await expect(page.getByTestId('appearance-status')).toHaveText(
      'Appearance changed to Bright Market.',
    );
    await page.reload();
    await expect(html).toHaveAttribute('data-skin', 'market');
    await expect(appearance.getByRole('radio', { name: 'Bright Market' })).toBeChecked();
    await ctx.close();
  });

  test('a fresh visitor with no cookie gets Bright Market, and an unknown cookie value is ignored', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: 'um_skin', value: 'neon', url: 'http://localhost:3100' }]);
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'market');
    await ctx.close();
  });
});

test.describe('sign out (FIX-FLOW D1)', () => {
  test('a signed in buyer signs out: the header goes back to Sign in and the pages close', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/signin?next=/library');
    await page.getByLabel('Who are you testing as?').selectOption('buyer-b');
    await page.getByLabel('Demo passcode').fill(PASSCODE);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'My library' })).toBeVisible();
    const header = page.getByRole('navigation', { name: 'Main' });
    await expect(header.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
    await ready(page);
    await header.getByRole('button', { name: 'Sign out' }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await expect(header.getByRole('link', { name: 'My library' })).toHaveCount(0);

    // The session is gone on the server too, not just hidden: the library sends the visitor to sign in.
    await page.goto('/library');
    await expect(page).toHaveURL(/\/signin\?next=(%2F|\/)library$/);
    await ctx.close();
  });
});
