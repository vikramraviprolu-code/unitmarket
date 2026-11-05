import { createHmac } from 'node:crypto';
import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { PASSCODE, TOTP_KEY_BYTES } from './support';

async function serverStep(page: Page): Promise<number> {
  const res = await page.request.get('/healthz');
  const ms = new Date(res.headers()['date'] ?? '').getTime();
  expect(Number.isFinite(ms)).toBe(true);
  return Math.floor(ms / 30_000);
}

function codeOf(step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', TOTP_KEY_BYTES).update(msg).digest();
  const o = (mac[19] ?? 0) & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Operator sign-in with one code, step + 1, and no retry (the refund.spec.ts behaviour that flakes). */
export async function operatorWithCode(
  browser: Browser,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const step = (await serverStep(page)) + 1;
  await page.goto('/signin?next=/ops');
  await page.getByLabel('Who are you testing as?').selectOption('operator');
  await page.getByLabel('Operator name').fill('vikram');
  await page.getByLabel('Demo passcode').fill(PASSCODE);
  await page.getByLabel('Authenticator code').fill(codeOf(step));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Operations/ })).toBeVisible();
  return { ctx, page };
}
