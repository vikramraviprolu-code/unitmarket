import { writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { AUTH_A, AUTH_B, PASSCODE } from './support';

for (const [persona, auth] of [
  ['buyer-a', AUTH_A],
  ['buyer-b', AUTH_B],
] as const) {
  test(`sign in as ${persona} once and save the session`, async ({ page }) => {
    await page.goto('/signin');
    await page.getByLabel('Who are you testing as?').selectOption(persona);
    await page.getByLabel('Demo passcode').fill(PASSCODE);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('link', { name: 'My library' })).toBeVisible();
    await page.context().storageState({ path: auth });
    const csrf = await page.evaluate(() => window.sessionStorage.getItem('um_csrf') ?? '');
    expect(csrf.length).toBeGreaterThan(10);
    writeFileSync(auth.replace(/\.json$/, '.csrf'), csrf);
  });
}
