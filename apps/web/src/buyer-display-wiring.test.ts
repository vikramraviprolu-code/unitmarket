// MC2-L5: the buyer screens that show a price take it from the one shared helper, and the screens that show
// what was settled (order status, receipts, library) never do. Source-level, like ux-phase1a.test.ts, because
// the unit runner does not render pages.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`./${p}`, import.meta.url), 'utf8');
const USES = /server\/buyer-display|lib\/buyer-price|buyer-price'|buyer-display'/;

describe('screens that show a price before payment use the shared display', () => {
  const pages = [
    'app/page.tsx',
    'app/discover/page.tsx',
    'app/o/[publisher]/[offer]/page.tsx',
    'app/approve/[id]/page.tsx',
    'app/api/quotes/route.ts',
    'app/api/discover/route.ts',
  ];
  for (const p of pages) {
    it(`${p} asks buyerDisplay`, () => {
      const src = read(p);
      expect(src).toMatch(/buyerDisplay\(/);
      expect(src).toMatch(USES);
    });
  }

  const clients = [
    'app/discover/DiscoverForm.tsx',
    'ui/FitCard.tsx',
    'app/o/[publisher]/[offer]/OfferFlow.tsx',
    'app/approve/[id]/ApproveClient.tsx',
  ];
  for (const p of clients) {
    it(`${p} shows the lead and the binding line, not its own conversion`, () => {
      const src = read(p);
      expect(src).toMatch(/binding/);
      expect(src).not.toMatch(/fx\.|convert\(/);
    });
  }

  it('the client files never compute a rate or import the engine', () => {
    for (const p of clients) {
      expect(read(p), p).not.toMatch(/server\/access|composition\.server|@umsbx\/fx/);
    }
  });
});

describe('screens that show what was settled stay in the seller currency', () => {
  const settled = [
    'app/orders/[ref]/page.tsx',
    'app/receipts/[order]/page.tsx',
    'app/library/page.tsx',
    'app/library/[entitlement]/page.tsx',
  ];
  for (const p of settled) {
    it(`${p} does not use the converted display`, () => {
      const src = read(p);
      expect(src).not.toMatch(/buyerDisplay|buyer-price|buyer-display/);
    });
  }
});

describe('one formatter', () => {
  it('the conversion words live in lib/buyer-price.ts only', () => {
    const files = [
      'app/page.tsx',
      'app/discover/page.tsx',
      'app/discover/DiscoverForm.tsx',
      'ui/FitCard.tsx',
      'ui/OfferTile.tsx',
      'app/o/[publisher]/[offer]/OfferFlow.tsx',
      'app/approve/[id]/ApproveClient.tsx',
      'server/buyer-display.ts',
    ];
    for (const p of files) expect(read(p), p).not.toMatch(/Binding:|sample rate|about \$\{/);
  });
});
