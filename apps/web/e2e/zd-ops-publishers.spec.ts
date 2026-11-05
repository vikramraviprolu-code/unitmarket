// HARD-E2E: the operator side of the publisher area, offline and dry run. A publisher asks for a payee change and an
// operator decides it (verify with the full id typed again, a wrong retype refused, a second request rejected);
// the operator publishers page suspends and reactivates a publisher and the publisher sees it.
//
// The operator signs in once with a code from the public RFC 6238 test key (see playwright.config.ts); the
// test makes the code from the server's own clock (the Date header of /healthz). A step may be used once, in
// rising order, so the code is for the step after the server's: refund.spec.ts did the same earlier. Should that
// step already be used, the sign-in is retried once the server's step has moved on (no sleep, a bounded poll).
// The file name keeps it after zcomposite.spec.ts and before zz-ops-stop.spec.ts, whose stop stays in force.
// Northfield Quarterly is used because its offers are in GBP, so no buyer journey depends on it.
import { createHmac } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { PASSCODE, TOTP_KEY_BYTES } from './support';

const PUBLISHER_PASSCODE = 'e2e publisher passcode';
const NORTHFIELD = 'Northfield Quarterly (fictional)';
const ID_ONE = 'E2EMERCHANT01'; // synthetic, 13 capital letters and digits; ends NT01
const ID_TWO = 'E2EMERCHANT02'; // ends NT02

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

async function operatorWithCode(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
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
    // The step was used already: wait for the server's step to pass it, then try the next one.
    await expect
      .poll(() => serverStep(page), { timeout: 45_000, intervals: [1000] })
      .toBeGreaterThanOrEqual(step);
  }
  throw new Error('operator sign-in with a code did not succeed');
}

async function publisherPage(
  browser: Browser,
  persona: string,
  next: string,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/signin?next=${next}`);
  await page.getByLabel('Who are you testing as?').selectOption(persona);
  await page.getByLabel('Publisher passcode').fill(PUBLISHER_PASSCODE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('publisher-name')).toBeVisible();
  return { ctx, page };
}

async function askForPayee(page: Page, merchant: string, note: string): Promise<void> {
  await page.goto('/publisher/payout-account');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('New merchant id').fill(merchant);
  await page.getByLabel('Why are you changing it?').fill(note);
  await page.getByRole('button', { name: 'Send the request' }).click();
  await expect(page.getByTestId('payee-request-result')).toHaveText(
    'Request sent. Nothing changes until an operator verifies it.',
  );
}

// The suspend form sits in a details element ("Change status"), open by default only for a suspended publisher.
async function openStatusForm(card: Locator): Promise<void> {
  const details = card.locator('details');
  const isOpen = await details.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!isOpen) await details.locator('summary').click();
}

test.describe.configure({ mode: 'serial' });

let op: { ctx: BrowserContext; page: Page };
let pub: { ctx: BrowserContext; page: Page };

test.beforeAll(async ({ browser }) => {
  op = await operatorWithCode(browser);
  pub = await publisherPage(browser, 'publisher-northfield-quarterly', '/publisher');
});

test.afterAll(async () => {
  await op.ctx.close();
  await pub.ctx.close();
});

test.describe('payee change requests (PUB-A2)', () => {
  test('a publisher asks for a payee change; the operator verifies it by typing the whole id again', async () => {
    const p = pub.page;
    await p.goto('/publisher/payout-account');
    await expect(p.getByTestId('payee-account')).toBeVisible();
    await askForPayee(p, ID_ONE, 'e2e payee change');
    await expect(p.getByTestId('payee-history')).toContainText('Account ending NT01. Open.');

    const o = op.page;
    await o.goto('/ops/payee-requests');
    await expect(o.getByRole('heading', { level: 1, name: /Payee requests/ })).toBeVisible();
    await o.waitForLoadState('networkidle');
    const row = o.getByTestId('payee-queue-row').filter({ hasText: NORTHFIELD });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Ending NT01');
    // Only the last four characters are ever shown.
    await expect(o.locator('main')).not.toContainText(ID_ONE);
    await row.getByLabel(/Type the full merchant id again/).fill(ID_ONE);
    await row.getByLabel('Reason').fill('e2e confirmed with the publisher');
    await row.getByRole('button', { name: 'Verify' }).click();
    // The page refreshes after the decision, so the decided row leaves the queue (its message goes with it).
    await expect(o.getByTestId('payee-queue-row').filter({ hasText: NORTHFIELD })).toHaveCount(0);

    await p.goto('/publisher/payout-account');
    await expect(p.getByTestId('payee-account')).toHaveText('Account on file ending NT01.');
    await expect(p.getByTestId('payee-verified')).toContainText('Verified on');
    await expect(p.getByTestId('payee-verified-by')).toHaveText(
      'An operator checked it. Not PayPal onboarding.',
    );
    await expect(p.getByTestId('payee-history')).toContainText('Account ending NT01. Verified.');
    // The full id is never on the publisher's page either.
    await expect(p.locator('main')).not.toContainText(ID_ONE);
  });

  test('a wrong retype changes nothing; a rejected request leaves the account as it was', async () => {
    const p = pub.page;
    await askForPayee(p, ID_TWO, 'e2e second change');
    const o = op.page;
    await o.goto('/ops/payee-requests');
    await o.waitForLoadState('networkidle');
    const row = o.getByTestId('payee-queue-row').filter({ hasText: NORTHFIELD });
    await expect(row).toContainText('Ending NT02');
    await row.getByLabel(/Type the full merchant id again/).fill('E2EMERCHANT99');
    await row.getByLabel('Reason').fill('e2e wrong retype');
    await row.getByRole('button', { name: 'Verify' }).click();
    await expect(row).toContainText(
      'The id you typed is not the id that was requested. Nothing changed.',
    );
    await row.getByRole('button', { name: 'Reject' }).click();
    await expect(o.getByTestId('payee-queue-row').filter({ hasText: NORTHFIELD })).toHaveCount(0);

    await p.goto('/publisher/payout-account');
    await expect(p.getByTestId('payee-account')).toHaveText('Account on file ending NT01.');
    await expect(p.getByTestId('payee-history')).toContainText('Account ending NT02. Rejected.');
    await expect(p.getByTestId('payee-history')).toContainText('Account ending NT01. Verified.');
  });
});

test.describe('operator publishers page (PUB-D)', () => {
  test('lists the publishers and links to the payee queue', async () => {
    const o = op.page;
    await o.goto('/ops');
    await o.getByRole('link', { name: 'Publishers' }).first().click();
    await expect(o).toHaveURL(/\/ops\/publishers$/);
    await expect(o.getByRole('heading', { level: 1, name: /Publishers/ })).toBeVisible();
    // Four publishers since MC2-L2 seeded the German seller Rheinwerft Kurier (the test followed the seed).
    await expect(o.getByTestId('publisher-row')).toHaveCount(4);
    const northfield = o.getByTestId('publisher-row').filter({ hasText: NORTHFIELD });
    await expect(northfield.getByTestId('publisher-row-status')).toHaveText('Active');
    await expect(northfield).toContainText('Account on file ending NT01. Marked as checked.');
    // INT-UI0: the Sellers section tabs link to it too, so the page's own link is read inside the main region.
    await expect(o.locator('#main').getByRole('link', { name: 'Payee requests' })).toBeVisible();
  });

  test('suspend needs a reason; a suspended publisher sees it; reactivate puts it back', async () => {
    const o = op.page;
    await o.goto('/ops/publishers');
    await o.waitForLoadState('networkidle');
    const northfield = () => o.getByTestId('publisher-row').filter({ hasText: NORTHFIELD });
    await openStatusForm(northfield());
    const suspend = northfield().getByRole('button', { name: 'Suspend this publisher' });
    await expect(suspend).toBeDisabled();
    await northfield()
      .getByLabel(/^Reason/)
      .fill('e2e suspension drill');
    await suspend.click();
    await expect(northfield()).toContainText('Suspended. The offers are off sale.');
    await o.reload();
    await expect(northfield().getByTestId('publisher-row-status')).toHaveText('Suspended');

    // The publisher's own home says so.
    await pub.page.goto('/publisher');
    await expect(pub.page.getByTestId('publisher-status')).toHaveText('Suspended');
    await expect(pub.page.getByTestId('publisher-notice')).toHaveText(
      'This account is suspended. Contact the operator.',
    );

    await o.waitForLoadState('networkidle');
    await openStatusForm(northfield());
    await northfield()
      .getByLabel(/^Reason/)
      .fill('e2e drill over');
    await northfield().getByRole('button', { name: 'Reactivate this publisher' }).click();
    await expect(northfield()).toContainText('Reactivated. The offers are back on sale.');
    await o.reload();
    await expect(northfield().getByTestId('publisher-row-status')).toHaveText('Active');
    await pub.page.goto('/publisher');
    await expect(pub.page.getByTestId('publisher-status')).toHaveText('Active');
    await expect(pub.page.getByTestId('publisher-notice')).toHaveCount(0);
  });

  test('an operator without the code is told why, and a publisher cannot open the operator pages', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const view = await ctx.newPage();
    await view.goto('/signin?next=/ops/payee-requests');
    await view.getByLabel('Who are you testing as?').selectOption('operator');
    await view.getByLabel('Demo passcode').fill(PASSCODE);
    await view.getByRole('button', { name: 'Sign in' }).click();
    await expect(view.getByTestId('payee-mfa-needed')).toBeVisible();
    await expect(view.getByTestId('payee-queue-row')).toHaveCount(0);
    await ctx.close();

    for (const path of ['/ops', '/ops/publishers', '/ops/payee-requests']) {
      await pub.page.goto(path);
      await expect(pub.page).toHaveURL(/\/signin/);
    }
  });
});
