// MC2-L5 (docs/specs/mc2-l5-buyer-currency-display.md; D-084 items 4, 5 and 9; D-085): what a buyer is shown.
// A DE buyer sees a USD offer as about euros with the rate date and the USD amount beside it; a GB buyer sees a
// euro offer as about pounds; a US buyer sees a USD offer as it is; a buyer from any other country sees the
// seller currency alone. A missing or old rate means the seller currency alone. The refresh runs at most once
// a request, never longer than its deadline, and never throws into the page.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { call } from './support';
import { RATES, bootDisplayWorld, longDate } from './buyer-display-support';
import type { DisplayWorld } from './buyer-display-support';
import { FX_DEADLINE_MS, buyerDisplay, currentRateSource } from './server/buyer-display';
import { approvePrices, optionPrices } from './lib/buyer-price';
import { browseEntries } from './lib/buyer-copy';

vi.mock('server-only', () => ({}));

let w: DisplayWorld;
beforeAll(async () => {
  w = await bootDisplayWorld();
});
afterAll(async () => {
  await w.close();
});

const USD = (minor: number) => ({ currency: 'USD', minor });
const EUR = (minor: number) => ({ currency: 'EUR', minor });

describe('buyerDisplay on the real engine (rates: 1 EUR = 1.2 USD = 0.8 GBP, dated today)', () => {
  it('a DE buyer sees a USD offer as about euros, rate date and the USD amount beside it', async () => {
    const { actor } = await w.buyer('DE');
    const d = await buyerDisplay(w.app.engine, actor, { currencies: ['USD'] });
    expect(d.target).toBe('EUR');
    expect(d.view(USD(40))).toEqual({
      seller: '$0.40',
      lead: 'about €0.33',
      binding: `Binding: $0.40 (rate of ${longDate(w.today)})`,
    });
  });

  it('a GB buyer sees a euro offer as about pounds', async () => {
    const { actor } = await w.buyer('GB');
    const d = await buyerDisplay(w.app.engine, actor, { currencies: ['EUR'] });
    expect(d.view(EUR(100))).toEqual({
      seller: '€1.00',
      lead: 'about £0.80',
      binding: `Binding: €1.00 (rate of ${longDate(w.today)})`,
    });
  });

  it('a US buyer sees a USD offer with no conversion line, and the engine is not asked for a rate', async () => {
    const { actor } = await w.buyer('US');
    const before = w.fetchCalls();
    const d = await buyerDisplay(w.app.engine, actor, { currencies: ['USD'] });
    expect(d.view(USD(150))).toEqual({ seller: '$1.50', lead: '$1.50', binding: null });
    expect(w.fetchCalls()).toBe(before);
  });

  it('a buyer from France sees the seller currency only, and nothing is fetched for them', async () => {
    const { actor } = await w.buyer('FR');
    const before = w.fetchCalls();
    const d = await buyerDisplay(w.app.engine, actor, { currencies: ['USD', 'EUR', 'GBP'] });
    expect(d.target).toBeNull();
    expect(d.view(USD(150))).toEqual({ seller: '$1.50', lead: '$1.50', binding: null });
    expect(d.view(EUR(150))).toEqual({ seller: '€1.50', lead: '€1.50', binding: null });
    expect(w.fetchCalls()).toBe(before);
  });

  it('a publisher and an operator see the seller currency only', async () => {
    for (const actor of [
      { kind: 'publisher', publisher_id: 'pub_x' },
      { kind: 'operator', operator_id: 'opr_demo', mfa: false },
    ] as Actor[]) {
      const d = await buyerDisplay(w.app.engine, actor, { currencies: ['USD'] });
      expect(d.target).toBeNull();
      expect(d.view(USD(40)).binding).toBeNull();
    }
  });

  it('JR-1: a signed-out visitor gets USD from the stored rate, with the seller amount binding', async () => {
    const d = await buyerDisplay(w.app.engine, null, { currencies: ['EUR'] });
    expect(d.target).toBe('USD');
    expect(d.view(EUR(100))).toEqual({
      seller: '€1.00',
      lead: 'about $1.20',
      binding: `Binding: €1.00 (rate of ${longDate(w.today)})`,
    });
    expect(d.view(USD(40))).toEqual({ seller: '$0.40', lead: '$0.40', binding: null });
  });

  it('JR-1: a signed-out visitor never triggers a rate refresh, even when asked to', async () => {
    const spy = vi.spyOn(w.app.engine.fx, 'refreshIfStale');
    const before = w.fetchCalls();
    try {
      await buyerDisplay(w.app.engine, null, { currencies: ['EUR'] });
      await buyerDisplay(w.app.engine, null, { currencies: ['EUR'], refresh: true });
      expect(spy).not.toHaveBeenCalled();
      expect(w.fetchCalls()).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });

  it('JR-1: a signed-out visitor falls back to the seller currency when the rate read fails', async () => {
    const spy = vi.spyOn(w.app.engine.fx, 'getRates').mockRejectedValue(new Error('down'));
    try {
      const d = await buyerDisplay(w.app.engine, null, { currencies: ['EUR'] });
      expect(d.view(EUR(100))).toEqual({ seller: '€1.00', lead: '€1.00', binding: null });
    } finally {
      spy.mockRestore();
    }
  });

  it('the account choice wins over the country: a DE buyer who chose GBP sees pounds', async () => {
    const { actor } = await w.buyer('DE', 'GBP');
    const d = await buyerDisplay(w.app.engine, actor, { currencies: ['USD'] });
    expect(d.target).toBe('GBP');
    // 40 USD cents at 1.2 USD and 0.8 GBP per EUR is 26.67, so 27
    expect(d.view(USD(40)).lead).toBe('about £0.27');
  });

  it('a buyer from France who chose USD sees dollars, and a euro offer converted', async () => {
    const { actor } = await w.buyer('FR', 'USD');
    const d = await buyerDisplay(w.app.engine, actor, { currencies: ['EUR'] });
    expect(d.view(EUR(100)).lead).toBe('about $1.20');
  });

  it('a price already in the buyer currency is shown as it is, even when others are converted', async () => {
    const { actor } = await w.buyer('DE');
    const d = await buyerDisplay(w.app.engine, actor, { currencies: ['EUR', 'USD'] });
    expect(d.view(EUR(150))).toEqual({ seller: '€1.50', lead: '€1.50', binding: null });
    expect(d.view(USD(120)).lead).toBe('about €1.00');
  });

  it('the figures are half away from zero: 1 USD cent at 1.2 is 0.83 cents, so 1', async () => {
    const { actor } = await w.buyer('DE');
    const d = await buyerDisplay(w.app.engine, actor, { currencies: ['USD'] });
    expect(d.view(USD(1)).lead).toBe('about €0.01');
    expect(d.view(USD(0)).lead).toBe('about €0.00');
  });

  it('browse entries, offer options and the approval use the same display', async () => {
    const { actor } = await w.buyer('DE');
    const offers = await w.app.engine.listOffers();
    const d = await buyerDisplay(w.app.engine, actor, {
      currencies: offers.map((o) => o.currency),
    });
    const tide = offers.find((o) => o.offer_code === 'tide-tables')!;
    const entry = browseEntries(offers, d.view).find((e) => e.offer_id === tide.offer_id)!;
    expect(entry.price_text).toBe('from about €0.33');
    expect(entry.binding_text).toBe(`Binding: $0.40 (rate of ${longDate(w.today)})`);
    const opts = optionPrices(tide, d.view);
    expect(opts['online_read']!.lead).toBe('about €0.33');
    // a German offer is already in euros: no second line
    const de = offers.find((o) => o.currency === 'EUR')!;
    expect(
      browseEntries(offers, d.view).find((e) => e.offer_id === de.offer_id)!.binding_text,
    ).toBe(null);
    const q = await w.app.engine.quote({
      offer: { publisher_slug: tide.publisher_slug, offer_code: tide.offer_code },
      actor,
      source: 'direct',
      option: 'online_read',
    });
    if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
    const g = await w.app.engine.requestApproval({
      actor,
      selection: { kind: 'quote', quote_id: q.value.quote_id },
      consent: { terms: true, identity_share: false },
    });
    if (!g.ok) throw new Error('no approval');
    const view = await w.app.engine.approvalView({ approval_id: g.value.approval_id, actor });
    const ap = approvePrices(view!, d.view);
    expect(ap.total).toEqual({
      seller: '$0.40',
      lead: 'about €0.33',
      binding: `Binding: $0.40 (rate of ${longDate(w.today)})`,
    });
    // what the approval holds is the seller's amount
    expect([view!.currency, view!.total_minor]).toEqual(['USD', 40]);
  });
});

describe('/api/quotes and /api/discover carry the display lines', () => {
  it('a DE buyer’s quote answer has display; a US buyer’s has none; the price field is unchanged', async () => {
    const quotes = await import('./app/api/quotes/route');
    const de = await w.buyer('DE');
    const us = await w.buyer('US');
    const ask = (s: typeof de.session) =>
      call(quotes.POST, {
        url: '/api/quotes',
        method: 'POST',
        session: s,
        body: { publisher: 'harbour-ledger', offer: 'tide-tables', option: 'online_read' },
      });
    const a = (await (await ask(de.session)).json()) as Record<string, unknown>;
    expect(a['kind']).toBe('quote');
    expect(a['price']).toEqual({ currency: 'USD', minor: 40 });
    expect(a['display']).toEqual({
      seller: '$0.40',
      lead: 'about €0.33',
      binding: `Binding: $0.40 (rate of ${longDate(w.today)})`,
    });
    const b = (await (await ask(us.session)).json()) as Record<string, unknown>;
    expect(b['price']).toEqual({ currency: 'USD', minor: 40 });
    expect('display' in b).toBe(false);
  });

  it('a DE buyer’s proposal items have display and keep the quote in the seller currency', async () => {
    const discover = await import('./app/api/discover/route');
    const de = await w.buyer('DE');
    const res = await call(discover.POST, {
      url: '/api/discover',
      method: 'POST',
      session: de.session,
      body: { need: 'tide tables, read online' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      items?: {
        quote: { price: { currency: string; minor: number } };
        display?: { lead: string };
      }[];
    };
    expect(body.kind).toBe('proposal');
    const usd = body.items!.filter((i) => i.quote.price.currency === 'USD');
    expect(usd.length).toBeGreaterThan(0);
    for (const it of usd) expect(it.display!.lead).toMatch(/^about €\d+\.\d\d$/);
  });

  it('the discover request refreshes the rate once, not once per item', async () => {
    const discover = await import('./app/api/discover/route');
    const de = await w.buyer('DE');
    const before = w.fetchCalls();
    // the fake stores today's date on the first call, so the next calls find a fresh rate: at most one call
    await call(discover.POST, {
      url: '/api/discover',
      method: 'POST',
      session: de.session,
      body: { need: 'tide tables, read online' },
    });
    expect(w.fetchCalls() - before).toBeLessThanOrEqual(1);
  });
});

describe('a ceiling compared on the converted price shows both amounts (F2)', () => {
  it('the discover answer has ceiling_check and a ceiling_line in the ceiling currency', async () => {
    const discover = await import('./app/api/discover/route');
    const de = await w.buyer('DE');
    const res = await call(discover.POST, {
      url: '/api/discover',
      method: 'POST',
      session: de.session,
      body: { need: 'tide tables, under €0.35, read online' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      items?: {
        quote: { offer_id: string; price: { currency: string; minor: number } };
        ceiling_check?: unknown;
        ceiling_line?: string;
      }[];
    };
    const tide = body.items!.find((i) => i.quote.offer_id === 'ofr_harbour-ledger_tide-tables')!;
    expect(tide.quote.price).toEqual({ currency: 'USD', minor: 40 });
    expect(tide.ceiling_check).toEqual({
      ceiling: { currency: 'EUR', minor: 35 },
      price: { currency: 'EUR', minor: 33 },
    });
    expect(tide.ceiling_line).toBe('Against your ceiling of €0.35: about €0.33.');
  });

  it('a buyer from France, who is shown no conversion, still gets the ceiling line', async () => {
    const discover = await import('./app/api/discover/route');
    const fr = await w.buyer('FR');
    const res = await call(discover.POST, {
      url: '/api/discover',
      method: 'POST',
      session: fr.session,
      body: { need: 'tide tables, under €0.35, read online' },
    });
    const body = (await res.json()) as { items?: { ceiling_line?: string; display?: unknown }[] };
    expect(
      body.items!.some((i) => i.ceiling_line === 'Against your ceiling of €0.35: about €0.33.'),
    ).toBe(true);
    for (const i of body.items!) expect('display' in i).toBe(false);
  });

  it('currentRateSource names the stored rate source, and is null with no rate or a failing read', async () => {
    const eng = (getRates: () => Promise<unknown>) =>
      ({ fx: { getRates } }) as unknown as Parameters<typeof currentRateSource>[0];
    expect(await currentRateSource(eng(async () => ({ source: 'seed' })))).toBe('seed');
    expect(await currentRateSource(eng(async () => ({ source: 'ecb' })))).toBe('ecb');
    expect(await currentRateSource(eng(async () => null))).toBeNull();
    expect(
      await currentRateSource(
        eng(async () => {
          throw new Error('db');
        }),
      ),
    ).toBeNull();
  });
});

describe('buyerDisplay with stand-in ports: old, missing and failing rates never block or throw', () => {
  const fx = (over: { refreshIfStale?: unknown; getRates?: unknown } = {}) =>
    ({ ...ports().fx, ...over }) as ReturnType<typeof ports>['fx'];
  function ports() {
    const real = w.app.engine.fx;
    return {
      fx: {
        refreshIfStale: vi.fn(async () => ({ status: 'fresh' as const })),
        getRates: vi.fn(async () => ({
          date: w.today,
          eur_usd: '1.2',
          eur_gbp: '0.8',
          fetched_at: '2026-11-04T10:00:00.000Z',
          age_ms: 0,
          source: 'ecb' as const,
        })),
        convert: real.convert,
      },
      displayCurrency: {
        get: vi.fn(async () => ({ country: 'DE', chosen: null })),
        set: vi.fn(async () => true),
      },
    };
  }
  const engine = (f: ReturnType<typeof fx>, dc = ports().displayCurrency) =>
    ({ fx: f, displayCurrency: dc }) as unknown as Parameters<typeof buyerDisplay>[0];
  const buyerA: Actor = { kind: 'buyer', buyer_id: 'buy_x' };

  it('a rate older than 7 days: the seller currency only', async () => {
    const f = fx({
      getRates: vi.fn(async () => ({
        date: '2020-01-01',
        eur_usd: '1.2',
        eur_gbp: '0.8',
        fetched_at: '2020-01-01T10:00:00.000Z',
        age_ms: 1,
        source: 'ecb' as const,
      })),
    });
    const d = await buyerDisplay(engine(f), buyerA, { currencies: ['USD'] });
    expect(d.view(USD(150))).toEqual({ seller: '$1.50', lead: '$1.50', binding: null });
  });

  it('no rate at all (null, or the read throws): the seller currency only', async () => {
    for (const getRates of [
      vi.fn(async () => null),
      vi.fn(async () => {
        throw new Error('db down');
      }),
    ]) {
      const d = await buyerDisplay(engine(fx({ getRates })), buyerA, { currencies: ['USD'] });
      expect(d.view(USD(150)).binding).toBeNull();
      expect(d.view(USD(150)).lead).toBe('$1.50');
    }
  });

  it('a refresh that throws or rejects is swallowed and the stored rate is still used', async () => {
    for (const refreshIfStale of [
      vi.fn(async () => {
        throw new Error('boom');
      }),
      vi.fn(() => {
        throw new Error('sync boom');
      }),
    ]) {
      const d = await buyerDisplay(engine(fx({ refreshIfStale })), buyerA, {
        currencies: ['USD'],
      });
      expect(d.view(USD(120)).lead).toBe('about €1.00');
    }
  });

  it('a refresh that never answers is cut at the deadline, and the page still renders', async () => {
    const hang = vi.fn(() => new Promise<never>(() => undefined));
    vi.useFakeTimers();
    try {
      let done = false;
      const pending = buyerDisplay(engine(fx({ refreshIfStale: hang })), buyerA, {
        currencies: ['USD'],
        deadline_ms: FX_DEADLINE_MS,
      }).then((d) => {
        done = true;
        return d;
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(FX_DEADLINE_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const d = await pending;
      expect(done).toBe(true);
      expect(hang).toHaveBeenCalledTimes(1);
      expect(d.view(USD(120)).lead).toBe('about €1.00');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the default deadline is the 3 second transport deadline', () => {
    expect(FX_DEADLINE_MS).toBe(3000);
  });

  it('the refresh is called once for the request, however many prices are viewed; never when nothing converts', async () => {
    const f = fx();
    const d = await buyerDisplay(engine(f), buyerA, { currencies: ['USD', 'GBP'] });
    for (let i = 0; i < 20; i++) d.view(USD(100 + i));
    expect(f.refreshIfStale).toHaveBeenCalledTimes(1);
    expect(f.getRates).toHaveBeenCalledTimes(1);
    const g = fx();
    await buyerDisplay(engine(g), buyerA, { currencies: ['EUR'] }); // DE buyer, euro offers only
    expect(g.refreshIfStale).not.toHaveBeenCalled();
    expect(g.getRates).not.toHaveBeenCalled();
    const h = fx();
    await buyerDisplay(engine(h), buyerA, { currencies: ['USD'], refresh: false });
    expect(h.refreshIfStale).not.toHaveBeenCalled();
    expect(h.getRates).toHaveBeenCalledTimes(1);
  });

  it('a seed rate reads "sample rate", never the bank', async () => {
    const f = fx({
      getRates: vi.fn(async () => ({
        date: w.today,
        eur_usd: '1.15',
        eur_gbp: '0.87',
        fetched_at: '2026-11-03T16:00:00.000Z',
        age_ms: 1,
        source: 'seed' as const,
      })),
    });
    const d = await buyerDisplay(engine(f), buyerA, { currencies: ['USD'] });
    const v = d.view(USD(115));
    expect(v.lead).toBe('about €1.00');
    expect(v.binding).toBe(`Binding: $1.15 (sample rate of ${longDate(w.today)})`);
  });

  it('a settings read that throws leaves the seller currency only', async () => {
    const dc = {
      get: vi.fn(async () => {
        throw new Error('db down');
      }),
      set: vi.fn(),
    };
    const d = await buyerDisplay(engine(fx(), dc as never), buyerA, { currencies: ['USD'] });
    expect(d.target).toBeNull();
    expect(d.view(USD(150)).lead).toBe('$1.50');
  });
});

describe('the display currency setting', () => {
  it('is stored on the buyer row, read back, and null again for "automatic"', async () => {
    const { actor } = await w.buyer('DE');
    expect(await w.app.engine.displayCurrency.get(actor)).toEqual({ country: 'DE', chosen: null });
    expect(await w.app.engine.displayCurrency.set({ actor, currency: 'USD' })).toBe(true);
    expect(await w.app.engine.displayCurrency.get(actor)).toEqual({ country: 'DE', chosen: 'USD' });
    const row = await w.app.db.query<{ display_currency: string | null }>(
      'SELECT display_currency FROM buyers WHERE id = $1',
      [(actor as { buyer_id: string }).buyer_id],
    );
    expect(row.rows[0]!.display_currency).toBe('USD');
    expect(await w.app.engine.displayCurrency.set({ actor, currency: null })).toBe(true);
    expect((await w.app.engine.displayCurrency.get(actor))!.chosen).toBeNull();
  });

  it('is for buyers only', async () => {
    const pub: Actor = { kind: 'publisher', publisher_id: 'pub_x' };
    expect(await w.app.engine.displayCurrency.get(pub)).toBeNull();
    expect(await w.app.engine.displayCurrency.set({ actor: pub, currency: 'USD' })).toBe(false);
  });

  it('POST /api/accounts/display-currency saves a choice for the signed-in buyer only', async () => {
    const route = await import('./app/api/accounts/display-currency/route');
    const b = await w.buyer('DE');
    const other = await w.buyer('DE');
    const post = (body: unknown, session: typeof b.session | null = b.session) =>
      call(route.POST, { url: '/api/accounts/display-currency', method: 'POST', session, body });
    const ok = await post({ currency: 'GBP' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ currency: 'GBP' });
    expect((await w.app.engine.displayCurrency.get(b.actor))!.chosen).toBe('GBP');
    expect((await w.app.engine.displayCurrency.get(other.actor))!.chosen).toBeNull();
    expect((await post({ currency: 'auto' })).status).toBe(200);
    expect((await w.app.engine.displayCurrency.get(b.actor))!.chosen).toBeNull();
  });

  it('refuses another currency, a wrong type, extra fields (such as a buyer id) and no session', async () => {
    const route = await import('./app/api/accounts/display-currency/route');
    const b = await w.buyer('DE');
    const other = await w.buyer('DE');
    const post = (body: unknown, session: typeof b.session | null = b.session) =>
      call(route.POST, { url: '/api/accounts/display-currency', method: 'POST', session, body });
    for (const bad of [
      { currency: 'JPY' },
      { currency: 'usd' },
      { currency: 3 },
      { currency: null },
      {},
      { currency: 'USD', buyer_id: (other.actor as { buyer_id: string }).buyer_id },
    ]) {
      const r = await post(bad);
      expect(r.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    expect((await post({ currency: 'USD' }, null)).status).toBeGreaterThanOrEqual(401);
    expect((await w.app.engine.displayCurrency.get(b.actor))!.chosen).toBeNull();
    expect((await w.app.engine.displayCurrency.get(other.actor))!.chosen).toBeNull();
  });
});

describe('the rates the display used', () => {
  it('are the stored ones: the fake fetch stored today with the test rates', async () => {
    const { actor } = await w.buyer('DE');
    await buyerDisplay(w.app.engine, actor, { currencies: ['USD'] });
    expect(await w.app.engine.fx.getRates()).toMatchObject({
      date: w.today,
      eur_usd: '1.2',
      eur_gbp: '0.8',
      source: 'ecb',
    });
    expect(RATES.usd).toBe('1.2000');
  });
});
