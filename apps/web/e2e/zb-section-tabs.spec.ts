// WEB-POLISH-4: the section tabs wrap instead of scrolling sideways. Offline, dry run, no purchase. The operator
// signs in once with a code from the public RFC 6238 test key (as zd-ops-publishers.spec.ts does: the code is
// made from the server's own clock, one step ahead, and retried once if that step was used already). The file
// name sorts before zcomposite, zd-ops and zz-ops-stop, whose stop stays in force.
// Pages: Operations (the owner's screenshot), and two public legal pages with the longest and widest tab sets
// (Terms has a 334 px pill, Publisher terms has 17 tabs). At 360, 700 and 1280 px the Operations bar is saved as
// a small PNG under test-results/ (ignored by git); the evidence copies are in docs/evidence/tabs-wrap-2026-11-02/.
// No width exists at which every page's tab set fits one row (see the spec), so the bar is static everywhere.
import { createHmac } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { PASSCODE, TOTP_KEY_BYTES } from './support';

const WIDTHS = [320, 360, 560, 700, 900, 1100, 1280, 1440, 1600] as const;
const SHOT_WIDTHS: readonly number[] = [360, 700, 1280];
const SKINS = ['market', 'harbour'] as const;
const PAGES = ['/ops', '/legal/terms', '/legal/publisher-terms'] as const;

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

interface Box {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

test.describe.serial('section tabs wrap', () => {
  let ctx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext();
    page = await ctx.newPage();
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
      if (await heading.isVisible()) return;
      await expect
        .poll(() => serverStep(page), { timeout: 45_000, intervals: [1000] })
        .toBeGreaterThanOrEqual(step);
    }
    throw new Error('operator sign-in with a code did not succeed');
  });

  test.afterAll(async () => {
    await ctx.close();
  });

  for (const skin of SKINS) {
    for (const width of WIDTHS) {
      test(`tabs at ${width}px in ${skin}`, async ({ baseURL }, testInfo) => {
        await ctx.addCookies([
          { name: 'um_skin', value: skin, url: baseURL ?? 'http://localhost:3100' },
        ]);
        await page.setViewportSize({ width, height: 800 });
        for (const path of PAGES) {
          await page.goto(path);
          await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
          await expect(page.getByTestId('section-nav')).toBeVisible();

          const m = await page.evaluate(() => {
            const box = (e: Element, name: string) => {
              const b = e.getBoundingClientRect();
              return { name, x: b.x, y: b.y, w: b.width, h: b.height };
            };
            const nav = document.querySelector('[data-testid="section-nav"]') as HTMLElement;
            return {
              bar: box(nav, 'bar'),
              scrollW: nav.scrollWidth,
              clientW: nav.clientWidth,
              overflowX: getComputedStyle(nav).overflowX,
              position: getComputedStyle(nav).position,
              pills: Array.from(nav.querySelectorAll('a')).map((a) =>
                box(a, (a.textContent ?? '').trim()),
              ),
              vw: document.documentElement.clientWidth,
            };
          });
          const where = `${path} at ${width}px in ${skin}`;

          expect(m.pills.length, `${where} pill count`).toBeGreaterThanOrEqual(3);
          // No sideways scroll and no scrollbar.
          expect(m.scrollW, `${where} bar scrollWidth`).toBeLessThanOrEqual(m.clientW);
          expect(m.overflowX, `${where} overflow-x`).toBe('visible');
          // No width exists where every page fits one row, so the bar is never sticky.
          expect(m.position, `${where} position`).toBe('static');
          for (const p of m.pills) {
            expect(p.h, `${where} ${p.name} touch target`).toBeGreaterThanOrEqual(44);
            expect(p.x, `${where} ${p.name} left in bar`).toBeGreaterThanOrEqual(m.bar.x - 0.5);
            expect(p.x + p.w, `${where} ${p.name} right in bar`).toBeLessThanOrEqual(
              m.bar.x + m.bar.w + 0.5,
            );
            expect(p.y, `${where} ${p.name} top in bar`).toBeGreaterThanOrEqual(m.bar.y - 0.5);
            expect(p.y + p.h, `${where} ${p.name} bottom in bar`).toBeLessThanOrEqual(
              m.bar.y + m.bar.h + 0.5,
            );
            expect(p.x, `${where} ${p.name} left in viewport`).toBeGreaterThanOrEqual(0);
            expect(p.x + p.w, `${where} ${p.name} right in viewport`).toBeLessThanOrEqual(m.vw);
          }
          const all: Box[] = m.pills;
          for (let i = 0; i < all.length; i++) {
            for (let j = i + 1; j < all.length; j++) {
              const a = all[i]!;
              const b = all[j]!;
              const apart =
                a.x + a.w <= b.x + 0.5 ||
                b.x + b.w <= a.x + 0.5 ||
                a.y + a.h <= b.y + 0.5 ||
                b.y + b.h <= a.y + 0.5;
              expect(apart, `${where}: "${a.name}" overlaps "${b.name}"`).toBe(true);
            }
          }

          if (path === '/ops' && SHOT_WIDTHS.includes(width)) {
            const nav = page.getByTestId('section-nav');
            await nav.screenshot({ path: testInfo.outputPath(`ops-tabs-${skin}-${width}.png`) });
          }
        }
      });
    }
  }

  // A tab jump lands with the heading visible: below the sticky site header (none on a phone), inside the window.
  for (const width of [360, 1280]) {
    test(`a tab jump lands below the header at ${width}px`, async ({ baseURL }) => {
      await ctx.addCookies([
        { name: 'um_skin', value: 'market', url: baseURL ?? 'http://localhost:3100' },
      ]);
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/ops');
      await page.getByTestId('section-nav').getByRole('link', { name: 'Approval gate' }).click();
      await expect(page).toHaveURL(/#ops-gate-section$/);
      const landed = async () =>
        page.evaluate(() => {
          const target = document.getElementById('ops-gate-section') as HTMLElement;
          const header = document.querySelector('.site-header') as HTMLElement;
          const headerBottom =
            getComputedStyle(header).position === 'sticky'
              ? header.getBoundingClientRect().bottom
              : 0;
          return {
            top: target.getBoundingClientRect().top,
            headerBottom,
            scrolled: window.scrollY > 0,
            vh: window.innerHeight,
          };
        });
      // Smooth scrolling: poll until the page has settled with the section at the top.
      await expect
        .poll(async () => {
          const l = await landed();
          return l.scrolled && l.top >= l.headerBottom - 1 && l.top < l.headerBottom + 80;
        })
        .toBe(true);
      const l = await landed();
      expect(l.top).toBeLessThan(l.vh);
    });
  }
});
