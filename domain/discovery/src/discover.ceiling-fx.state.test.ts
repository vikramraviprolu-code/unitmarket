// MC2-L5 (D-084 item 4): a brief ceiling in another currency than the offer is compared on the offer price
// converted into the ceiling currency at the stored rate, rounded half away from zero. With no usable rate
// only offers in the ceiling's own currency count, as before. Nothing stored is converted: the quote stays in
// the offer's currency. The convert function is injected (discovery never reads the rate table itself).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { createScriptedModel } from '@umsbx/model';
import { discover, parseNeed } from './index';
import type { DiscoveryResult } from './index';
import {
  addBuyer,
  depsWith,
  extraData,
  recordingModel,
  seedArticle,
  seedBoth,
  seedOffer,
  seededDb,
} from './support';
import type { TestDb } from './support';

// One USD article at 1.60, with a topic word no other article has.
const zebra = seedArticle(
  'zf1',
  'Zebrafish fins and their growth',
  'Zebrafish study.',
  ['zebrafish'],
  '2026-10-10T09:00:00.000Z',
);
const NEED = 'zebrafish fins, under €1.50, read online, English';

/** A fixed table: USD per EUR. Rounds half away from zero like @umsbx/fx. Other pairs: no rate. */
const usdPerEur =
  (rate: number) =>
  (i: { minor: number; from: string; to: string }): number | null => {
    if (i.from === i.to) return i.minor;
    if (i.from === 'USD' && i.to === 'EUR') return Math.round(i.minor / rate);
    if (i.from === 'EUR' && i.to === 'USD') return Math.round(i.minor * rate);
    return null;
  };

let db: TestDb;
beforeAll(async () => {
  ({ db } = await seededDb(extraData([zebra], [seedOffer('zf1', seedBoth(160, 160))])));
});
afterAll(async () => {
  await db.close();
});

async function run(convert?: (i: { minor: number; from: string; to: string }) => number | null) {
  const rec = recordingModel(createScriptedModel());
  const deps = depsWith(db, rec.model);
  const actor: Actor = { kind: 'buyer', buyer_id: await addBuyer(db, { country: 'DE' }) };
  const b = await parseNeed(deps, { actor, text: NEED });
  if (!b.ok) throw new Error(`parse ${b.error.code}`);
  expect(b.value.ceiling).toEqual({ currency: 'EUR', minor: 150 });
  const r = await discover(deps, {
    actor,
    brief_id: b.value.brief_id,
    ...(convert !== undefined ? { convert } : {}),
  });
  if (!r.ok) throw new Error('discover');
  return { result: r.value, rec };
}
const proposal = (r: DiscoveryResult) => {
  if (r.kind !== 'proposal') throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r;
};

describe('discover: ceiling on the converted price', () => {
  it('1.60 USD that converts to about 1.47 EUR is proposed under a 1.50 EUR ceiling', async () => {
    const { result } = await run(usdPerEur(1.09));
    const p = proposal(result);
    const it1 = p.items.find((i) => i.quote.offer_id === 'ofr_harbour-ledger_zf1')!;
    expect(it1).toBeDefined();
    // the quote is the seller's, unconverted
    expect(it1.quote.price).toEqual({ currency: 'USD', minor: 160 });
    // the proposal shows both amounts
    expect(it1.ceiling_check).toEqual({
      ceiling: { currency: 'EUR', minor: 150 },
      price: { currency: 'EUR', minor: 147 },
    });
  });

  it('the same offer at a rate where it converts to 1.55 EUR is not proposed, and says above the ceiling', async () => {
    const { result } = await run(usdPerEur(1.0323));
    expect(result).toEqual({ kind: 'no_match', reasons: ['above_ceiling'] });
  });

  it('the budget row of the fit card compares the converted price and says it is about that', async () => {
    const { result } = await run(usdPerEur(1.09));
    const item = proposal(result).items.find((i) => i.quote.offer_id === 'ofr_harbour-ledger_zf1')!;
    const budget = item.fit.dimensions.find((d) => d.key === 'budget')!;
    expect(budget.evidence).toBe('about €1.47 of your €1.50');
    expect(budget.level).not.toBeNull();
  });

  it('a converted price exactly equal to the ceiling is proposed (inclusive, like the same-currency rule)', async () => {
    // 160 USD converts to exactly 150 EUR minor units here
    const { result } = await run((i) =>
      i.from === 'USD' && i.to === 'EUR' ? Math.round((i.minor * 15) / 16) : null,
    );
    const item = proposal(result).items.find((i) => i.quote.offer_id === 'ofr_harbour-ledger_zf1')!;
    expect(item.ceiling_check!.price.minor).toBe(150);
  });

  it('with no convert function only offers in the ceiling currency count: no match, and it says the rate is missing', async () => {
    const { result, rec } = await run(undefined);
    expect(result).toEqual({ kind: 'no_match', reasons: [], rate_missing: true });
    // the USD article was never even a candidate
    expect(rec.requests.find((r) => r.purpose === 'pack_compose')).toBeUndefined();
  });

  it('with a convert function that has no usable rate (stale or missing) the answer is the same', async () => {
    const { result, rec } = await run(() => null);
    expect(result).toEqual({ kind: 'no_match', reasons: [], rate_missing: true });
    expect(rec.requests.find((r) => r.purpose === 'pack_compose')).toBeUndefined();
  });

  // F1: a pick that cannot be converted when its price is known is never proposed and never silent.
  it('a pick whose price cannot be converted is dropped with rate_missing (the probe passed, the price did not)', async () => {
    const { result } = await run((i) => (i.minor === 100 ? 100 : null));
    expect(result).toEqual({ kind: 'no_match', reasons: [], rate_missing: true });
  });

  it('a convert function that throws never throws out of discovery: no match, rate_missing', async () => {
    const boom = () => {
      throw new Error('rate table unreadable');
    };
    const { result } = await run(boom);
    expect(result).toEqual({ kind: 'no_match', reasons: [], rate_missing: true });
    const later = await run((i) => {
      if (i.minor === 100) return 100;
      throw new Error('boom');
    });
    expect(later.result).toEqual({ kind: 'no_match', reasons: [], rate_missing: true });
  });

  it('an honest above-ceiling answer carries no rate_missing, and neither does a same-currency one', async () => {
    const { result } = await run(usdPerEur(1.0323));
    expect(result).toEqual({ kind: 'no_match', reasons: ['above_ceiling'] });
    expect('rate_missing' in result).toBe(false);
    const rec = recordingModel(createScriptedModel());
    const deps = depsWith(db, rec.model);
    const actor: Actor = { kind: 'buyer', buyer_id: await addBuyer(db, { country: 'DE' }) };
    const b = await parseNeed(deps, { actor, text: 'zebrafish fins, under $1.00, read online' });
    if (!b.ok) throw new Error('parse');
    const r = await discover(deps, { actor, brief_id: b.value.brief_id, convert: usdPerEur(1.09) });
    if (!r.ok) throw new Error('discover');
    expect('rate_missing' in r.value).toBe(false);
  });

  it('the stored quote keeps the offer currency and the seller amount', async () => {
    const { result } = await run(usdPerEur(1.09));
    const qid = proposal(result).items.find((i) => i.quote.offer_id === 'ofr_harbour-ledger_zf1')!
      .quote.quote_id;
    const row = await db.query<{ currency: string; price_minor: string | number }>(
      'SELECT currency, price_minor FROM quotes WHERE id = $1',
      [qid],
    );
    expect(row.rows.map((r) => [r.currency, Number(r.price_minor)])).toEqual([['USD', 160]]);
  });

  it('a ceiling in the offer currency is compared as before and carries no ceiling_check', async () => {
    const rec = recordingModel(createScriptedModel());
    const deps = depsWith(db, rec.model);
    const actor: Actor = { kind: 'buyer', buyer_id: await addBuyer(db, { country: 'DE' }) };
    const b = await parseNeed(deps, { actor, text: 'zebrafish fins, under $1.60, read online' });
    if (!b.ok) throw new Error('parse');
    const r = await discover(deps, {
      actor,
      brief_id: b.value.brief_id,
      convert: usdPerEur(1.09),
    });
    if (!r.ok) throw new Error('discover');
    const item = proposal(r.value).items.find(
      (i) => i.quote.offer_id === 'ofr_harbour-ledger_zf1',
    )!;
    expect('ceiling_check' in item).toBe(false);
    const budget = item.fit.dimensions.find((d) => d.key === 'budget')!;
    expect(budget.evidence).toBe('$1.60 of your $1.60');
  });
});
