// INT-UI0 e2e (offline, dry run, no purchase): the shared shell. Old anchors land on their stubs on Home and
// the stub link reaches the block; the bottom bar shows at 390 px; "/" focuses the search slot and sends no
// request; the breadcrumb shows on /ops/money; every operator tab sends a buyer, a seller and an anonymous
// visitor to sign-in; a buyer or anonymous visitor is refused on seller tabs; seller tabs show no buyer
// identity. The operator signs in once with a code from the public RFC 6238 test key, as
// zb-section-tabs.spec.ts does. The file name sorts after refund.spec.ts and before zb-section-tabs.spec.ts and
// zz-ops-stop.spec.ts, so the codes rise in order.
import { createHmac } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { PASSCODE, TOTP_KEY_BYTES, buyerPage } from './support';

const PUBLISHER_PASSCODE = 'e2e publisher passcode';
const OPS_TABS = [
  '/ops',
  '/ops/money',
  '/ops/sellers',
  '/ops/controls',
  '/ops/publishers',
  '/ops/payee-requests',
  '/ops/evals',
] as const;
const SELLER_TABS = [
  '/publisher',
  '/publisher/offers',
  '/publisher/sales',
  '/publisher/statement',
  '/publisher/payout-account',
] as const;
/** The anchors that moved: old id, where it lands. */
const MOVED = [
  ['ops-switches', '/ops/controls'],
  ['ops-gate-section', '/ops/controls'],
  ['ops-refunds', '/ops/money'],
  ['ops-orders', '/ops/money'],
  ['ops-totals', '/ops/money'],
  ['ops-states', '/ops/money'],
  ['ops-invariants', '/ops/money'],
  ['ops-shared-payee', '/ops/sellers'],
] as const;

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
    await expect
      .poll(() => serverStep(page), { timeout: 45_000, intervals: [1000] })
      .toBeGreaterThanOrEqual(step);
  }
  throw new Error('operator sign-in with a code did not succeed');
}

async function sellerPage(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/signin?next=/publisher');
  await page.getByLabel('Who are you testing as?').selectOption('publisher-harbour-ledger');
  await page.getByLabel('Publisher passcode').fill(PUBLISHER_PASSCODE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('publisher-name')).toBeVisible();
  return { ctx, page };
}

const tabsNav = (page: Page, persona: string) =>
  page.getByRole('navigation', { name: `${persona} pages`, exact: true });

test.describe.serial('operator shell', () => {
  let op: { ctx: BrowserContext; page: Page };
  test.beforeAll(async ({ browser }) => {
    op = await operatorWithCode(browser);
  });
  test.afterAll(async () => {
    await op.ctx.close();
  });

  test('the tabs show the ready operator pages only, and the current one says so', async () => {
    await op.page.setViewportSize({ width: 1280, height: 800 });
    await op.page.goto('/ops/money');
    const nav = tabsNav(op.page, 'Operator');
    await expect(nav.getByRole('link')).toHaveText(['Home', 'Sellers', 'Money', 'Controls']);
    await expect(nav.getByRole('link', { name: 'Buyers' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Agents and API' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Money' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current', /.+/);
  });

  test('the environment pill comes from stored data', async () => {
    await op.page.goto('/ops/money');
    await expect(op.page.getByTestId('env-label').first()).toContainText('Dry run');
  });

  test('the breadcrumb shows on /ops/money', async () => {
    await op.page.goto('/ops/money');
    const crumbs = op.page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs).toBeVisible();
    await expect(crumbs.getByRole('link', { name: 'Operator' })).toHaveAttribute('href', '/ops');
    await expect(crumbs.getByText('Money')).toHaveAttribute('aria-current', 'page');
  });

  test('Sellers shows its section tabs on the old Publishers URL', async () => {
    await op.page.goto('/ops/publishers');
    await expect(
      tabsNav(op.page, 'Operator').getByRole('link', { name: 'Sellers' }),
    ).toHaveAttribute('aria-current', 'page');
    const sub = op.page.getByRole('navigation', { name: 'Sellers sections' });
    await expect(sub.getByRole('link')).toHaveText(['Overview', 'Publishers', 'Payee requests']);
    await expect(sub.getByRole('link', { name: 'Publishers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the kill switch and the alerts stay on Home at their old anchors', async () => {
    for (const id of ['ops-kill', 'ops-alerts']) {
      await op.page.goto(`/ops#${id}`);
      await expect(op.page.locator(`#${id}`)).toBeVisible();
      await expect(op.page).toHaveURL(new RegExp(`/ops#${id}$`));
    }
    await expect(op.page.getByRole('button', { name: 'Stop PayPal now' })).toBeVisible();
  });

  for (const [id, to] of MOVED) {
    test(`/ops#${id} lands on its stub, and the stub link reaches the block on ${to}`, async () => {
      await op.page.setViewportSize({ width: 1280, height: 800 });
      await op.page.goto(`/ops#${id}`);
      const stub = op.page.locator(`#${id}`);
      await expect(stub).toBeVisible();
      const link = stub.getByRole('link');
      await expect(link).toHaveAttribute('href', `${to}#${id}`);
      await link.click();
      await expect(op.page).toHaveURL(new RegExp(`${to}#${id}$`));
      await expect(op.page.locator(`#${id}`)).toBeVisible();
      // The block, not another stub: a stub holds one sentence and no data.
      await expect(op.page.locator(`#${id}`)).not.toContainText('moved to');
    });
  }

  test('the refund panel and the switches are on their new pages with their controls', async () => {
    await op.page.goto('/ops/money');
    await expect(
      op.page.getByTestId('refund-panel').or(op.page.getByTestId('refund-no-mfa')),
    ).toBeVisible();
    await op.page.goto('/ops/controls');
    await expect(op.page.getByTestId('ops-gate')).toBeVisible();
    await expect(op.page.getByTestId('ops-switch-paypal_outbound')).toBeVisible();
  });

  test('at 390 px the bottom bar shows and the top tabs do not; at 1280 px it is the other way', async () => {
    await op.page.setViewportSize({ width: 390, height: 800 });
    await op.page.goto('/ops');
    const bar = op.page.getByTestId('shell-phonebar');
    await expect(bar).toBeVisible();
    await expect(op.page.getByTestId('shell-tabs')).toBeHidden();
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    for (const a of await bar.getByRole('link').all()) {
      const b = await a.boundingBox();
      expect(b?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await op.page.setViewportSize({ width: 1280, height: 800 });
    await expect(bar).toBeHidden();
    await expect(op.page.getByTestId('shell-tabs')).toBeVisible();
  });

  test('pressing / focuses the search slot and sends no request', async () => {
    await op.page.setViewportSize({ width: 1280, height: 800 });
    await op.page.goto('/ops');
    await op.page.waitForLoadState('networkidle');
    const input = op.page.getByTestId('shell-search-input');
    await expect(input).not.toBeFocused();
    const seen: string[] = [];
    op.page.on('request', (r) => seen.push(r.url()));
    await op.page.locator('body').press('/');
    await expect(input).toBeFocused();
    await input.press('Enter');
    await op.page.waitForTimeout(400);
    expect(seen).toEqual([]);
    // A slash typed into a field stays a slash.
    await input.fill('a');
    await input.press('/');
    await expect(input).toHaveValue('a/');
  });

  test('every operator tab opens for the operator', async () => {
    for (const path of OPS_TABS) {
      const res = await op.page.goto(path);
      expect(res?.status(), path).toBe(200);
      expect(new URL(op.page.url()).pathname, path).toBe(path);
      await expect(op.page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    }
  });
  // Evidence for the PR: light (Bright Market) and dark (Deep Harbour) screenshots of each tab at desktop and
  // phone width. The PNGs go to the ignored test-results folder; the evidence copies are committed under docs/evidence/.
  test('screenshots of every operator tab', async ({ baseURL }, testInfo) => {
    await shoot(op.page, baseURL, testInfo.outputPath.bind(testInfo), 'operator', [...OPS_TABS]);
  });
});

/** One screenshot per skin and width for each path. */
async function shoot(
  page: Page,
  baseURL: string | undefined,
  out: (name: string) => string,
  persona: string,
  paths: readonly string[],
): Promise<void> {
  for (const [skin] of [['market'], ['harbour']] as const) {
    await page
      .context()
      .addCookies([{ name: 'um_skin', value: skin, url: baseURL ?? 'http://localhost:3100' }]);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of paths) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const name = `${persona}${path.replace(/\//g, '-')}-${skin}-${width}.png`;
        await page.screenshot({ path: out(name) });
      }
    }
  }
}

test.describe('refusals', () => {
  test('anonymous, buyer and seller sessions land on sign-in for every operator tab', async ({
    browser,
  }) => {
    const anon = await browser.newContext();
    const buyer = await buyerPage(browser, 'a');
    const seller = await sellerPage(browser);
    for (const page of [await anon.newPage(), buyer, seller.page]) {
      for (const path of OPS_TABS) {
        await page.goto(path);
        expect(new URL(page.url()).pathname, path).toBe('/signin');
      }
    }
    await anon.close();
    await buyer.context().close();
    await seller.ctx.close();
  });

  test('anonymous and buyer sessions are refused on every seller tab', async ({ browser }) => {
    const anon = await browser.newContext();
    const buyer = await buyerPage(browser, 'a');
    for (const page of [await anon.newPage(), buyer]) {
      for (const path of SELLER_TABS) {
        await page.goto(path);
        expect(new URL(page.url()).pathname, path).toBe('/signin');
      }
    }
    await anon.close();
    await buyer.context().close();
  });

  test('the seller shell lists the five seller tabs and shows no buyer identity', async ({
    browser,
  }) => {
    const s = await sellerPage(browser);
    await s.page.setViewportSize({ width: 1280, height: 800 });
    for (const path of SELLER_TABS) {
      await s.page.goto(path);
      const nav = tabsNav(s.page, 'Seller');
      await expect(nav.getByRole('link')).toHaveText([
        'Home',
        'Offers',
        'Sales',
        'Money',
        'Account',
      ]);
      const shellText = [
        await nav.innerText(),
        await s.page.getByRole('navigation', { name: 'Breadcrumb' }).innerText(),
      ].join(' ');
      expect(shellText).not.toMatch(/buyer|@|library|discover/i);
    }
    await expect(
      s.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Seller' }),
    ).toBeVisible();
    await s.ctx.close();
  });

  test('a buyer sees the buyer shell, the ready tabs only, and no operator or seller tab', async ({
    browser,
  }) => {
    const buyer = await buyerPage(browser, 'a');
    await buyer.setViewportSize({ width: 1280, height: 800 });
    await buyer.goto('/buyer');
    const nav = tabsNav(buyer, 'Buyer');
    await expect(nav.getByRole('link')).toHaveText(['Home', 'Find', 'Library']);
    await expect(
      buyer.getByRole('navigation', { name: 'Operator pages', exact: true }),
    ).toHaveCount(0);
    await expect(buyer.getByRole('navigation', { name: 'Seller pages', exact: true })).toHaveCount(
      0,
    );
    await buyer.context().close();
  });

  test('screenshots of the seller and buyer tabs', async ({ browser, baseURL }, testInfo) => {
    const seller = await sellerPage(browser);
    await shoot(seller.page, baseURL, testInfo.outputPath.bind(testInfo), 'seller', SELLER_TABS);
    await seller.ctx.close();
    const buyer = await buyerPage(browser, 'a');
    await shoot(buyer, baseURL, testInfo.outputPath.bind(testInfo), 'buyer', [
      '/buyer',
      '/discover',
      '/library',
    ]);
    await buyer.context().close();
  });
});
