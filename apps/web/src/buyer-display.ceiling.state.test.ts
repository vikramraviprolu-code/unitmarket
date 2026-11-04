// MC2-L5 follow-up F4: the converted price is rounded to a whole minor unit, half away from zero, and only
// then compared with the ceiling, inclusively. This is the reading of the spec ("compare it with the offer
// price converted to the buyer currency at the stored rate, rounded half away from zero"; ceiling 1.50 EUR,
// "about 1.47" is proposed, 1.55 is not). So a true 150.4 cents passes a 150 ceiling (it rounds to 150, and
// 150 is not above 150) and a true 150.51 cents does not (it rounds to 151). Truncating or rounding up would
// each get one of the two wrong. Real engine, real fx.convert; the seeded $1.25 ferry article.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { call } from './support';
import { bootDisplayWorld } from './buyer-display-support';
import type { DisplayWorld } from './buyer-display-support';

vi.mock('server-only', () => ({}));

const worlds: DisplayWorld[] = [];
afterAll(async () => {
  for (const w of worlds) await w.close();
});

type Item = {
  quote: { offer_id: string; price: { currency: string; minor: number } };
  ceiling_check?: { ceiling: { minor: number }; price: { currency: string; minor: number } };
};
async function ferry(usdPerEur: string): Promise<Item | undefined> {
  const w = await bootDisplayWorld('rates', { usd: usdPerEur, gbp: '0.8000' });
  worlds.push(w);
  const discover = await import('./app/api/discover/route');
  const de = await w.buyer('DE');
  const res = await call(discover.POST, {
    url: '/api/discover',
    method: 'POST',
    session: de.session,
    body: { need: 'ferry timetables, under €1.50, read online' },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { kind: string; items?: Item[] };
  return body.items?.find((i) => i.quote.offer_id === 'ofr_harbour-ledger_ferry-timetables');
}

describe('the converted compare rounds half away from zero, then compares inclusively', () => {
  it('125 USD cents at 0.831117 USD per EUR is a true 150.40 EUR cents: rounds to 150, passes a 150 ceiling', async () => {
    const item = await ferry('0.831117');
    expect(item).toBeDefined();
    expect(item!.quote.price).toEqual({ currency: 'USD', minor: 125 });
    expect(item!.ceiling_check!.price).toEqual({ currency: 'EUR', minor: 150 });
  });

  it('125 USD cents at 0.8305 USD per EUR is a true 150.51 EUR cents: rounds to 151, is above a 150 ceiling', async () => {
    expect(await ferry('0.830500')).toBeUndefined();
  });
});
