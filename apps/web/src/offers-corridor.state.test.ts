// MC-GBP (docs/specs/multi-currency-gbp.md): the public offer list follows the enabled corridors. Since 0034
// (WW-COR) gb-gbp is on at boot, so the pounds offers (Northfield Quarterly) are listed with the US dollar offers;
// switching gb-gbp off takes them off sale, and switching it on lists them again.
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
  it('lists USD and GBP offers at boot, drops the pounds offers when gb-gbp is off, and lists them again when it is on', async () => {
    const before = await listed();
    expect(before.publishers.has('harbour-ledger')).toBe(true);
    expect(before.publishers.has('northfield-quarterly')).toBe(true);
    expect(before.currencies.has('USD')).toBe(true);
    expect(before.currencies.has('GBP')).toBe(true);

    await w.app.db.query("UPDATE corridors SET enabled = false WHERE id = 'gb-gbp'");
    const off = await listed();
    expect(off.publishers.has('harbour-ledger')).toBe(true);
    expect(off.publishers.has('northfield-quarterly')).toBe(false);
    expect([...off.currencies]).toEqual(['USD']);

    await w.app.db.query("UPDATE corridors SET enabled = true WHERE id = 'gb-gbp'");
    const after = await listed();
    expect(after.publishers.has('northfield-quarterly')).toBe(true);
    expect(after.currencies.has('GBP')).toBe(true);
  });
});
