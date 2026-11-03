// MC-GBP (docs/specs/multi-currency-gbp.md): the public offer list follows the enabled corridors. With the
// seed only us-usd is on, so the pounds offers (Northfield Quarterly) are off sale; switching gb-gbp on
// lists them, and the US dollar offers are listed either way.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootPayeeWorld } from './payee-support';
import type { PayeeWebWorld } from './payee-support';

vi.mock('server-only', () => ({}));

let w: PayeeWebWorld;
beforeAll(async () => {
  w = await bootPayeeWorld();
});
afterAll(async () => {
  await w.app.close();
});

const listed = async (): Promise<{ publishers: Set<string>; currencies: Set<string> }> => {
  const offers = await w.app.engine.listOffers();
  return {
    publishers: new Set(offers.map((o) => o.publisher_slug)),
    currencies: new Set(offers.map((o) => o.currency)),
  };
};

describe('the offer list follows the enabled corridors', () => {
  it('lists USD offers only while gb-gbp is off, and the pounds offers once it is on', async () => {
    const before = await listed();
    expect(before.publishers.has('harbour-ledger')).toBe(true);
    expect(before.publishers.has('northfield-quarterly')).toBe(false);
    expect([...before.currencies]).toEqual(['USD']);

    await w.app.db.query("UPDATE corridors SET enabled = true WHERE id = 'gb-gbp'");
    const after = await listed();
    expect(after.publishers.has('harbour-ledger')).toBe(true);
    expect(after.publishers.has('northfield-quarterly')).toBe(true);
    expect(after.currencies.has('USD')).toBe(true);
    expect(after.currencies.has('GBP')).toBe(true);
  });
});
