// FIX-PAY2 LOW: GET /checkout/return captures, so a cross-site <img>, <iframe> or fetch must not be
// able to fire it. The browser's own Sec-Fetch headers tell a page navigation (the buyer coming back
// from PayPal, or from our dry-run page) from a sub-resource load.
import { describe, expect, it } from 'vitest';
import { isBuyerNavigation } from './return-guard';

const h = (o: Record<string, string>) => (name: string) => o[name.toLowerCase()] ?? null;

describe('isBuyerNavigation', () => {
  it('accepts a top-level navigation from PayPal (cross-site), from our own page and a typed URL', () => {
    expect(
      isBuyerNavigation(
        h({
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'cross-site',
        }),
      ),
    ).toBe(true);
    expect(
      isBuyerNavigation(
        h({
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toBe(true);
    expect(
      isBuyerNavigation(
        h({ 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' }),
      ),
    ).toBe(true);
  });
  it('refuses an image, a frame, a script, a fetch and a prefetch', () => {
    expect(
      isBuyerNavigation(
        h({
          'sec-fetch-dest': 'image',
          'sec-fetch-mode': 'no-cors',
          'sec-fetch-site': 'cross-site',
        }),
      ),
    ).toBe(false);
    expect(
      isBuyerNavigation(
        h({
          'sec-fetch-dest': 'iframe',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'cross-site',
        }),
      ),
    ).toBe(false);
    expect(
      isBuyerNavigation(
        h({
          'sec-fetch-dest': 'script',
          'sec-fetch-mode': 'no-cors',
          'sec-fetch-site': 'cross-site',
        }),
      ),
    ).toBe(false);
    expect(
      isBuyerNavigation(
        h({ 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' }),
      ),
    ).toBe(false);
    expect(
      isBuyerNavigation(
        h({
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-purpose': 'prefetch',
        }),
      ),
    ).toBe(false);
  });
  it('refuses a request with no Sec-Fetch headers (an old client or a script): the page asks for a click', () => {
    expect(isBuyerNavigation(h({}))).toBe(false);
  });
});
