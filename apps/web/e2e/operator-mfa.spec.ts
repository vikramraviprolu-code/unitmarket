// CO-6 e2e (offline, dry run): an operator signs in with the passcode and a code from an authenticator.
// The server is started with a fixed fake key (the RFC 6238 test key, see playwright.config.ts); the
// test makes the code itself, from the server's own clock (the Date header of /healthz, so the test
// reads no clock of its own). Runs before zz-ops-stop.spec.ts (file name order).
import { createHmac } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { PASSCODE, TOTP_KEY_BYTES } from './support';

async function currentCode(page: Page, stepOffset = 0): Promise<string> {
  const res = await page.request.get('/healthz');
  const serverMs = new Date(res.headers()['date'] ?? '').getTime();
  expect(Number.isFinite(serverMs)).toBe(true);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(serverMs / 30_000) + stepOffset));
  const mac = createHmac('sha1', TOTP_KEY_BYTES).update(msg).digest();
  const o = (mac[19] ?? 0) & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

// The page navigates away as soon as sign-in succeeds, and the browser then drops the response body,
// so the body is read inside a route handler, before the page sees the answer.
async function fillAndSubmit(page: Page, o: { name?: string; code?: string }): Promise<Answer> {
  let answer: Answer | null = null;
  await page.route('**/api/session', async (route) => {
    const res = await route.fetch();
    answer = { status: res.status(), body: (await res.json()) as Record<string, unknown> };
    await route.fulfill({ response: res });
  });
  await page.goto('/signin?next=/ops');
  await page.getByLabel('Who are you testing as?').selectOption('operator');
  if (o.name !== undefined) await page.getByLabel('Operator name').fill(o.name);
  await page.getByLabel('Demo passcode').fill(PASSCODE);
  if (o.code !== undefined) await page.getByLabel('Authenticator code').fill(o.code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => answer, { timeout: 10_000 }).not.toBeNull();
  return answer as unknown as Answer;
}

test.describe('operator sign-in with a code', () => {
  test('a generated code reaches /ops with mfa on, so refunds and switch-on are open to this session', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // Fields for the second factor appear only for the operator persona.
    await page.goto('/signin?next=/ops');
    await expect(page.getByLabel('Authenticator code')).toHaveCount(0);
    await page.getByLabel('Who are you testing as?').selectOption('operator');
    await expect(page.getByLabel('Operator name')).toBeVisible();
    await expect(page.getByLabel('Authenticator code')).toBeVisible();
    const code = await currentCode(page);
    const res = await fillAndSubmit(page, { name: 'vikram', code });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ actor_kind: 'operator', mfa: true });
    await expect(page.getByRole('heading', { level: 1, name: /Operations/ })).toBeVisible();
    // The page and its scripts never carry the key or the code.
    const html = await page.content();
    expect(html).not.toContain(code);
    await ctx.close();
  });

  test('a wrong code is refused with a plain message and the form keeps no secret', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const real = await currentCode(page, 0);
    const wrong = String((Number(real) + 123457) % 1_000_000).padStart(6, '0');
    const res = await fillAndSubmit(page, { name: 'vikram', code: wrong });
    expect(res.status).toBe(401);
    await expect(page.getByText(/did not work/)).toBeVisible();
    await expect(page).toHaveURL(/\/signin/);
    await ctx.close();
  });

  test('without a code the operator signs in view-only (mfa off)', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const res = await fillAndSubmit(page, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ actor_kind: 'operator', mfa: false });
    await expect(page.getByRole('heading', { level: 1, name: /Operations/ })).toBeVisible();
    await ctx.close();
  });
});
