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

/**
 * Operator sign-in with a code from the public RFC 6238 test key. The server accepts a TOTP step once, in
 * rising order, and every operator spec uses step + 1, so a spec that runs soon after another can send a
 * step already spent. Then the page shows "That did not work.": wait for the server's step to reach the
 * spent one and try the next. Three attempts, as shell.spec.ts, quick-find.spec.ts and the others do.
 */
export async function operatorWithCode(
  browser: Browser,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const heading = page.getByRole('heading', { level: 1, name: /Operations/ });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const step = (await serverStep(page)) + 1;
    await page.goto('/signin?next=/ops');
    await page.getByLabel('Who are you testing as?').selectOption('operator');
    await page.getByLabel('Operator name').fill('vikram');
    await page.getByLabel('Demo passcode').fill(PASSCODE);
    await page.getByLabel('Authenticator code').fill(codeOf(step));
    await page.getByRole('button', { name: 'Sign in' }).click();
    const failed = page.getByText('That did not work.');
    await expect(heading.or(failed)).toBeVisible();
    if (await heading.isVisible()) return { ctx, page };
    await expect
      .poll(() => serverStep(page), { timeout: 45_000, intervals: [1000] })
      .toBeGreaterThanOrEqual(step);
  }
  throw new Error('operator sign-in with a code did not succeed');
}
