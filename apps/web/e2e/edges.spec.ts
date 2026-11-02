// WEB-POLISH-3: the header content, the page column and the footer share one left and right edge from 560 px
// up, in both skins, and the three blocks of /account share one width. Offline, dry run, no purchase.
// /account shows the password form and the sign out card only to a buyer with an account (a test persona has
// none), so the spec makes one synthetic account first. Synthetic values only; the address is its own.
import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { buyerPage } from './support';

const WIDTHS = [600, 700, 900, 1100, 1199, 1200, 1280, 1440, 1600] as const;
const SKINS = ['market', 'harbour'] as const;
const USER = 'edges.reader';
const PW = 'violet lamps hum softly';

async function setSkin(page: Page, skin: (typeof SKINS)[number], width: number): Promise<void> {
  await page.context().addCookies([{ name: 'um_skin', value: skin, url: 'http://localhost:3100' }]);
  await page.setViewportSize({ width, height: 800 });
}

async function frameEdges(page: Page) {
  return page.evaluate(() => {
    const edges = (e: Element) => {
      const b = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return {
        left: b.left + parseFloat(s.paddingLeft),
        right: b.right - parseFloat(s.paddingRight),
      };
    };
    const header = document.querySelector('.site-header') as HTMLElement;
    const brand = header.querySelector('.brand') as HTMLElement;
    const items = Array.from(
      header.querySelectorAll('.brand, nav a, nav .btn, .env, .skin-switch'),
    );
    return {
      brandLeft: brand.getBoundingClientRect().left,
      itemsRight: Math.max(...items.map((e) => e.getBoundingClientRect().right)),
      envRight: (header.querySelector('.env') as HTMLElement).getBoundingClientRect().right,
      inner: edges(header.querySelector('.inner') as HTMLElement),
      main: edges(document.querySelector('main') as HTMLElement),
      footer: edges(document.querySelector('.site-footer') as HTMLElement),
      scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

for (const skin of SKINS) {
  for (const width of WIDTHS) {
    test(`header, page and footer share their edges at ${width}px in ${skin}`, async ({
      browser,
    }) => {
      const page = await buyerPage(browser);
      await setSkin(page, skin, width);
      await page.goto('/library');
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
      const m = await frameEdges(page);
      expect(Math.abs(m.brandLeft - m.main.left), 'brand left vs main left').toBeLessThanOrEqual(1);
      expect(Math.abs(m.inner.left - m.main.left), 'header inner vs main left').toBeLessThanOrEqual(
        1,
      );
      expect(
        Math.abs(m.inner.right - m.main.right),
        'header inner vs main right',
      ).toBeLessThanOrEqual(1);
      expect(Math.abs(m.footer.left - m.main.left), 'footer vs main left').toBeLessThanOrEqual(1);
      expect(Math.abs(m.footer.right - m.main.right), 'footer vs main right').toBeLessThanOrEqual(
        1,
      );
      expect(m.itemsRight, 'last header item past main right').toBeLessThanOrEqual(
        m.main.right + 1,
      );
      expect(m.envRight, 'label past main right').toBeLessThanOrEqual(m.main.right + 1);
      expect(m.scroll).toBeLessThanOrEqual(0);
      await page.context().close();
    });
  }
}

test.describe('the account page', () => {
  let ctx: BrowserContext;
  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.77' } });
    const page = await ctx.newPage();
    await page.goto('/signup');
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Display name').fill('Edges Reader');
    await page.getByLabel('Username').fill(USER);
    await page.getByLabel(/^Country/).fill('GB');
    await page.getByLabel('Password', { exact: true }).fill(PW);
    await page.getByLabel('Repeat password').fill(PW);
    await page.getByRole('checkbox', { name: /I accept the Terms and the Privacy notice/ }).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    // A worker restart after a failed test runs this again; the name is then taken, so sign in instead.
    const made = await page
      .waitForURL(/\/discover$/, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!made) {
      await page.goto('/signin/buyer');
      await page.waitForLoadState('networkidle');
      await page.getByLabel('Username').fill(USER);
      await page.getByLabel('Password').fill(PW);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('link', { name: 'Account' }).first()).toBeVisible();
    }
    await page.close();
  });
  test.afterAll(async () => {
    await ctx.close();
  });

  for (const skin of SKINS) {
    for (const width of WIDTHS) {
      test(`the three cards share one left edge and width at ${width}px in ${skin}`, async () => {
        const page = await ctx.newPage();
        await setSkin(page, skin, width);
        await page.goto('/account');
        await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
        const m = await page.evaluate(() => {
          const box = (e: Element) => {
            const b = e.getBoundingClientRect();
            return { left: b.left, width: b.width };
          };
          const wrap = document.querySelector('[data-testid="account-page"]') as HTMLElement;
          return {
            cards: [
              box(wrap.querySelector('.auth-head')!),
              box(wrap.querySelector('.auth-form')!),
              box(wrap.querySelector('.auth-card')!),
            ],
            main: box(document.querySelector('main')!),
            mainPad: parseFloat(getComputedStyle(document.querySelector('main')!).paddingLeft),
            brand: box(document.querySelector('.site-header .brand')!),
          };
        });
        const [head, form, all] = m.cards as [
          { left: number; width: number },
          { left: number; width: number },
          { left: number; width: number },
        ];
        for (const c of [form, all]) {
          expect(Math.abs(c.left - head.left), 'left edge').toBeLessThanOrEqual(1);
          expect(Math.abs(c.width - head.width), 'width').toBeLessThanOrEqual(1);
        }
        // The cards start at the page column's content edge, which is where the brand starts.
        expect(Math.abs(head.left - (m.main.left + m.mainPad))).toBeLessThanOrEqual(1);
        expect(Math.abs(head.left - m.brand.left)).toBeLessThanOrEqual(1);
        await page.close();
      });
    }
  }
});
