// WEB-POLISH-1: the signed-in header (the widest link set) at every width, in both skins. Offline, dry run, no
// purchase. At 360, 700 and 1280 px it also saves a small header PNG under test-results/ (ignored by git); the
// evidence copies in docs/evidence/header-wrap-2026-11-02/ are taken from there.
import { test, expect } from '@playwright/test';
import { buyerPage } from './support';

const WIDTHS = [320, 360, 520, 559, 560, 600, 700, 900, 1100, 1199, 1200, 1280] as const;
const SHOT_WIDTHS: readonly number[] = [360, 700, 1280];
const SKINS = ['market', 'harbour'] as const;

interface Box {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

for (const skin of SKINS) {
  for (const width of WIDTHS) {
    test(`header at ${width}px in ${skin}`, async ({ browser }, testInfo) => {
      const page = await buyerPage(browser);
      await page
        .context()
        .addCookies([{ name: 'um_skin', value: skin, url: 'http://localhost:3100' }]);
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/library');
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
      await expect(page.locator('.site-header nav').getByRole('link')).toHaveCount(4);

      const m = await page.evaluate(() => {
        const box = (e: Element, name: string) => {
          const b = e.getBoundingClientRect();
          return { name, x: b.x, y: b.y, w: b.width, h: b.height };
        };
        const header = document.querySelector('.site-header') as HTMLElement;
        const links = Array.from(header.querySelectorAll('nav a, nav .btn')).map((e) =>
          box(e, (e.textContent ?? '').trim()),
        );
        const others = [
          ...Array.from(header.querySelectorAll('.brand, .env')).map((e) =>
            box(e, (e.textContent ?? '').trim().slice(0, 12)),
          ),
          ...Array.from(header.querySelectorAll('.skin-switch button')).map((e) =>
            box(e, `switch ${(e.textContent ?? '').trim()}`),
          ),
        ];
        const nav = header.querySelector('nav') as HTMLElement;
        return {
          header: box(header, 'header'),
          links,
          others,
          pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          navScroll: nav.scrollWidth - nav.clientWidth,
          position: getComputedStyle(header).position,
          headerH: parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--header-h'),
          ),
        };
      });

      expect(m.links.map((l) => l.name)).toEqual([
        'Find articles',
        'My library',
        'Account',
        'Help',
        'Sign out',
      ]);
      // One line each, and still a 44px target.
      for (const l of m.links) {
        expect(l.h, `${l.name} height`).toBeLessThan(60);
        expect(l.h, `${l.name} touch target`).toBeGreaterThanOrEqual(44);
      }
      // Nothing overlaps anything else in the header.
      const all: Box[] = [...m.links, ...m.others];
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i]!;
          const b = all[j]!;
          const apart =
            a.x + a.w <= b.x + 0.5 ||
            b.x + b.w <= a.x + 0.5 ||
            a.y + a.h <= b.y + 0.5 ||
            b.y + b.h <= a.y + 0.5;
          expect(apart, `${a.name} overlaps ${b.name}`).toBe(true);
        }
      }
      // Everything stays inside the header's own box, and inside the window.
      for (const it of all) {
        expect(it.y, `${it.name} top`).toBeGreaterThanOrEqual(m.header.y - 0.5);
        expect(it.y + it.h, `${it.name} bottom`).toBeLessThanOrEqual(m.header.y + m.header.h + 0.5);
        expect(it.x, `${it.name} left`).toBeGreaterThanOrEqual(-0.5);
        expect(it.x + it.w, `${it.name} right`).toBeLessThanOrEqual(width + 0.5);
      }
      // No sideways scroll on the page, and no link hidden inside a scrolling nav.
      expect(m.pageScroll).toBeLessThanOrEqual(0);
      expect(m.navScroll).toBeLessThanOrEqual(0);
      // The Sign out pill sits on the same centre line as the links beside it.
      const out = m.links[4]!;
      for (const l of m.links.slice(0, 4)) {
        if (Math.abs(l.y - out.y) < 20) {
          expect(
            Math.abs(l.y + l.h / 2 - (out.y + out.h / 2)),
            `${l.name} vs Sign out`,
          ).toBeLessThanOrEqual(1.5);
        }
      }
      // A sticky header is exactly --header-h tall, so the section tabs stick directly under it; on a phone
      // the header scrolls away and --header-h is 0.
      if (m.position === 'sticky') {
        expect(width).toBeGreaterThanOrEqual(560);
        expect(Math.abs(m.header.h - m.headerH)).toBeLessThanOrEqual(1);
      } else {
        expect(width).toBeLessThan(560);
        expect(m.headerH).toBe(0);
      }

      if (SHOT_WIDTHS.includes(width)) {
        await page.screenshot({
          path: testInfo.outputPath(`buyer-${skin}-${width}.png`),
          clip: { x: 0, y: 0, width, height: Math.ceil(m.header.h) + 24 },
        });
      }
      await page.context().close();
    });
  }
}
