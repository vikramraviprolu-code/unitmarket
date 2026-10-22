import { writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { AUTH_A, PASSCODE } from './support';

test('sign in as buyer A once and save the session', async ({ page }) => {
  await page.goto('/signin');
  await page.getByLabel('Who are you testing as?').selectOption('buyer-a');
  await page.getByLabel('Demo passcode').fill(PASSCODE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'My library' })).toBeVisible();
  await page.context().storageState({ path: AUTH_A });
  const csrf = await page.evaluate(() => window.sessionStorage.getItem('um_csrf') ?? '');
  expect(csrf.length).toBeGreaterThan(10);
  writeFileSync(AUTH_A.replace(/\.json$/, '.csrf'), csrf);
});
