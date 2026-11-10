import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, CoreDeps, NoMatch, Quote } from '@umsbx/contracts';
import { getOffer } from '@umsbx/catalogue';
import { startFromOffer } from './index';
import { addBuyer, giveEntitlement, seededDb, T0, type TestDb } from './support';

let db: TestDb;
let deps: CoreDeps;
beforeAll(async () => {
  ({ db, deps } = await seededDb());
});
afterAll(async () => {
  await db.close();
});

const slug = 'harbour-ledger';
const by = (offer_code: string, publisher_slug = slug) => ({ publisher_slug, offer_code });
const buyer = async (country = 'US'): Promise<Actor> => ({
  kind: 'buyer',
  buyer_id: await addBuyer(db, country),
});

async function run(offer_code: string, extra: Record<string, unknown> = {}, publisher_slug = slug) {
  const r = await startFromOffer(deps, {
    offer: by(offer_code, publisher_slug),
    actor: await buyer(),
    source: 'direct',
    ...extra,
  } as Parameters<typeof startFromOffer>[1]);
  if (!r.ok) throw new Error(`unexpected error ${r.error.code}`);
  return r.value;
}
const quote = (v: Quote | NoMatch): Quote => {
  if (v.kind !== 'quote') throw new Error(`expected quote, got ${v.reason}`);
  return v;
};
const noMatchErr = (): never => {
  throw new Error('unexpected error result');
};
const noMatch = (v: Quote | NoMatch): NoMatch => {
  if (v.kind !== 'no_match') throw new Error('expected no_match');
  return v;
};

describe('quote', () => {
  it('quote within ceiling, valid 15 min (A-05)', async () => {
    const q = quote(await run('ferry-timetables', { ceiling_minor: 200 }));
    expect(q.price).toEqual({ currency: 'USD', minor: 125 });
    expect(q.corridor_id).toBe('us-usd');
    expect(q.expires_at).toBe('2026-10-21T10:15:00.000Z');
    expect(q.source).toBe('direct');
    const stored = await db.query<{ price_minor: number; option: string; corridor_id: string }>(
      'SELECT price_minor, option, corridor_id FROM quotes WHERE id = $1',
      [q.quote_id],
    );
    expect(stored.rows).toEqual([{ price_minor: 125, option: q.option, corridor_id: 'us-usd' }]);
    const o = await getOffer(db, { offer_id: q.offer_id });
    expect(q.offer_version).toBe(o!.offer.version);
  });

  it('ceiling equal to the price is within the ceiling', async () => {
    expect(quote(await run('ferry-timetables', { ceiling_minor: 125 })).price.minor).toBe(125);
  });

  it('ceiling below price gives above_ceiling and no alternative (A-05)', async () => {
    const v = noMatch(await run('ferry-timetables', { ceiling_minor: 124 }));
    expect(v).toEqual({ kind: 'no_match', reason: 'above_ceiling' });
    expect(Object.keys(v).sort()).toEqual(['kind', 'reason']);
  });

  it('0.40 USD offer quotes 0.40 (A-06)', async () => {
    const q = quote(await run('tide-tables', { ceiling_minor: 40 }));
    expect(q.price).toEqual({ currency: 'USD', minor: 40 });
  });

  it('the requested option sets the price; an absent option takes the cheapest', async () => {
    expect(quote(await run('harbour-fees', { option: 'keep_retrieve' })).price.minor).toBe(300);
    expect(quote(await run('harbour-fees', { option: 'online_read' })).price.minor).toBe(250);
    const q = quote(await run('harbour-fees'));
    expect(q.option).toBe('online_read');
    expect(q.price.minor).toBe(250);
  });

  it('an anonymous visitor (actor null) can get a quote; no buyer is stored', async () => {
    const r = await startFromOffer(deps, {
      offer: by('tide-tables'),
      actor: null,
      source: 'wordpress',
    });
    expect(r.ok && r.value.kind === 'quote').toBe(true);
    const id = r.ok && r.value.kind === 'quote' ? r.value.quote_id : '';
    const s = await db.query<{ buyer_id: string | null; source: string }>(
      'SELECT buyer_id, source FROM quotes WHERE id=$1',
      [id],
    );
    expect(s.rows).toEqual([{ buyer_id: null, source: 'wordpress' }]);
  });

  it('a corridor min_charge is a corridor rule: a price below it is corridor_unsupported', async () => {
    await db.query("UPDATE corridors SET min_charge_minor = 50 WHERE id = 'us-usd'");
    try {
      expect(noMatch(await run('tide-tables'))).toEqual({
        kind: 'no_match',
        reason: 'corridor_unsupported',
      });
      expect(quote(await run('ferry-timetables')).price.minor).toBe(125);
    } finally {
      await db.query("UPDATE corridors SET min_charge_minor = NULL WHERE id = 'us-usd'");
    }
  });
});

describe('renegotiation (A-07)', () => {
  it('2.50 accepted at 2.50 on an offer that allows it (floor 2.00)', async () => {
    const q = quote(await run('harbour-fees', { option: 'keep_retrieve', proposed_minor: 250 }));
    expect(q.price.minor).toBe(250);
  });
  it('exactly the floor is accepted', async () => {
    expect(
      quote(await run('harbour-fees', { option: 'keep_retrieve', proposed_minor: 200 })).price
        .minor,
    ).toBe(200);
  });
  it('1.90 is below_publisher_floor, without a counter-offer', async () => {
    const v = noMatch(await run('harbour-fees', { option: 'keep_retrieve', proposed_minor: 190 }));
    expect(v).toEqual({ kind: 'no_match', reason: 'below_publisher_floor' });
  });
  it('a proposal above the listed price never raises the price', async () => {
    expect(
      quote(await run('harbour-fees', { option: 'keep_retrieve', proposed_minor: 900 })).price
        .minor,
    ).toBe(300);
  });
  it('the ceiling applies to the negotiated price', async () => {
    expect(
      noMatch(
        await run('harbour-fees', {
          option: 'keep_retrieve',
          proposed_minor: 250,
          ceiling_minor: 240,
        }),
      ).reason,
    ).toBe('above_ceiling');
  });
  it('offer without renegotiation refuses lower and ignores higher', async () => {
    expect(noMatch(await run('ferry-timetables', { proposed_minor: 100 }))).toEqual({
      kind: 'no_match',
      reason: 'below_publisher_floor',
    });
    expect(quote(await run('ferry-timetables', { proposed_minor: 500 })).price.minor).toBe(125);
    expect(quote(await run('ferry-timetables', { proposed_minor: 125 })).price.minor).toBe(125);
  });
});

describe('no-match reasons and decision order', () => {
  it('unknown offer is an error, not a no-match', async () => {
    const r = await startFromOffer(deps, { offer: by('nope'), actor: null, source: 'direct' });
    expect(r).toEqual({ ok: false, error: { code: 'unknown_offer' } });
    const r2 = await startFromOffer(deps, {
      offer: { offer_id: 'ofr_nothing' },
      actor: null,
      source: 'direct',
    });
    expect(r2).toEqual({ ok: false, error: { code: 'unknown_offer' } });
  });

  it('withdrawn, unauthorised, disabled corridor, already owned each give their reason', async () => {
    expect(noMatch(await run('dock-history'))).toEqual({ kind: 'no_match', reason: 'withdrawn' });
    expect(noMatch(await run('draft-weather-notes'))).toEqual({
      kind: 'no_match',
      reason: 'not_authorised',
    });
    await db.query("UPDATE corridors SET enabled = false WHERE id = 'gb-gbp'");
    try {
      expect(noMatch(await run('allotment-diary', {}, 'northfield-quarterly'))).toEqual({
        kind: 'no_match',
        reason: 'corridor_unsupported',
      });
    } finally {
      await db.query("UPDATE corridors SET enabled = true WHERE id = 'gb-gbp'");
    }
    const actor = await buyer();
    const o = await getOffer(db, by('knot-notebook'));
    await giveEntitlement(db, {
      buyer_id: actor.kind === 'buyer' ? actor.buyer_id : '',
      article_id: o!.article.id,
      publisher_id: o!.publisher.id,
      access_state: 'available',
      window: 'running',
    });
    const r = await startFromOffer(deps, { offer: by('knot-notebook'), actor, source: 'direct' });
    expect(r.ok && r.value).toEqual({ kind: 'no_match', reason: 'already_owned' });
    // another buyer is not affected
    expect(quote(await run('knot-notebook')).price.minor).toBe(450);
  });

  it('superseded, expired and not-yet-valid offers are withdrawn', async () => {
    for (const code of ['edge-superseded', 'edge-expired', 'edge-notyet']) {
      expect(noMatch(await run(code)), code).toEqual({ kind: 'no_match', reason: 'withdrawn' });
    }
  });

  it('an ended entitlement does not count as owned', async () => {
    const actor = await buyer();
    const id = actor.kind === 'buyer' ? actor.buyer_id : '';
    const o = await getOffer(db, by('tide-tables'));
    await giveEntitlement(db, {
      buyer_id: id,
      article_id: o!.article.id,
      publisher_id: o!.publisher.id,
      access_state: 'ended',
      window: 'ended',
    });
    const r = await startFromOffer(deps, { offer: by('tide-tables'), actor, source: 'direct' });
    expect(r.ok && r.value.kind).toBe('quote');
  });

  // FIX-05A H3: an entitlement whose money is pending, unknown or captured and whose access is not
  // ended or revoked is held, even when it is locked (probes D and E: no second charge).
  it.each([
    ['pending', 'locked'],
    ['unknown', 'locked'],
    ['captured', 'locked'],
  ])('money %s with access %s counts as owned', async (money_state, access_state) => {
    const actor = await buyer();
    const o = await getOffer(db, by('tide-tables'));
    await giveEntitlement(db, {
      buyer_id: actor.kind === 'buyer' ? actor.buyer_id : '',
      article_id: o!.article.id,
      publisher_id: o!.publisher.id,
      access_state,
      window: 'not_started',
      money_state,
    });
    const r = await startFromOffer(deps, { offer: by('tide-tables'), actor, source: 'direct' });
    expect(r.ok && r.value).toEqual({ kind: 'no_match', reason: 'already_owned' });
  });

  it.each([
    ['denied', 'locked'],
    ['refunded', 'revoked'],
    ['captured', 'revoked'],
    ['captured', 'ended'],
  ])('money %s with access %s does not count as owned', async (money_state, access_state) => {
    const actor = await buyer();
    const o = await getOffer(db, by('tide-tables'));
    await giveEntitlement(db, {
      buyer_id: actor.kind === 'buyer' ? actor.buyer_id : '',
      article_id: o!.article.id,
      publisher_id: o!.publisher.id,
      access_state,
      window: null,
      money_state,
    });
    const r = await startFromOffer(deps, { offer: by('tide-tables'), actor, source: 'direct' });
    expect(r.ok && r.value.kind).toBe('quote');
  });

  it('option not offered', async () => {
    expect(noMatch(await run('edge-onlyread', { option: 'keep_retrieve' }))).toEqual({
      kind: 'no_match',
      reason: 'option_not_offered',
    });
    expect(quote(await run('edge-onlyread', { option: 'online_read' })).price.minor).toBe(40);
    expect(quote(await run('edge-onlyread')).option).toBe('online_read');
  });

  it('decision order: withdrawn beats not_authorised beats corridor beats option beats owned', async () => {
    // a withdrawn offer on a disabled corridor reports withdrawn first
    // draft offer (not authorised) reports not_authorised even with an absurd ceiling
    expect(noMatch(await run('draft-weather-notes', { ceiling_minor: 1 })).reason).toBe(
      'not_authorised',
    );
    // disabled corridor beats above_ceiling
    await db.query("UPDATE corridors SET enabled = false WHERE id = 'gb-gbp'");
    try {
      expect(
        noMatch(await run('allotment-diary', { ceiling_minor: 1 }, 'northfield-quarterly')).reason,
      ).toBe('corridor_unsupported');
    } finally {
      await db.query("UPDATE corridors SET enabled = true WHERE id = 'gb-gbp'");
    }
  });

  it('India to India corridor refused as corridor_unsupported', async () => {
    const actor = await buyer('IN');
    const r = await startFromOffer(deps, {
      offer: by('monsoon-notes', 'delhi-desk'),
      actor,
      source: 'direct',
    });
    expect(r.ok && r.value).toEqual({ kind: 'no_match', reason: 'corridor_unsupported' });
  });

  // MC2-L1 (D-084 3): replaces "a buyer from outside every corridor of the publisher is
  // corridor_unsupported". The buyer's country is data, not a gate; the corridor follows the offer.
  it('a buyer from DE is quoted a USD offer in us-usd (buyer_countries is [*] since 0034)', async () => {
    const actor = await buyer('DE');
    const r = await startFromOffer(deps, { offer: by('tide-tables'), actor, source: 'direct' });
    const q = quote(r.ok ? r.value : noMatchErr());
    expect(q.corridor_id).toBe('us-usd');
    expect(q.price.currency).toBe('USD');
    const row = await db.query<{ buyer_countries: string[] }>(
      `SELECT buyer_countries FROM corridors WHERE id = 'us-usd'`,
    );
    expect(row.rows[0]!.buyer_countries).toEqual(['*']);
  });

  it('a buyer from DE is quoted a GBP offer while gb-gbp is enabled, and refused once it is off', async () => {
    const actor = await buyer('DE');
    const go = () =>
      startFromOffer(deps, {
        offer: by('allotment-diary', 'northfield-quarterly'),
        actor,
        source: 'direct',
      });
    const on = await go();
    const q = quote(on.ok ? on.value : noMatchErr());
    expect(q.corridor_id).toBe('gb-gbp');
    expect(q.price.currency).toBe('GBP');
    await db.query(`UPDATE corridors SET enabled = false WHERE id = 'gb-gbp'`);
    try {
      const off = await go();
      expect(off.ok && off.value).toEqual({ kind: 'no_match', reason: 'corridor_unsupported' });
    } finally {
      await db.query(`UPDATE corridors SET enabled = true WHERE id = 'gb-gbp'`);
    }
  });

  it('an offer whose currency has no corridor for its publisher country is corridor_unsupported', async () => {
    await db.query(
      `UPDATE offers SET currency = 'EUR' WHERE id = 'ofr_harbour-ledger_harbour-fees'`,
    );
    // de-eur now covers every payee country; switch it off so no enabled EUR corridor covers a US payee.
    await db.query(`UPDATE corridors SET enabled = false WHERE id = 'de-eur'`);
    try {
      const actor = await buyer('DE');
      const r = await startFromOffer(deps, {
        offer: by('harbour-fees'),
        actor,
        source: 'direct',
      });
      expect(r.ok && r.value).toEqual({ kind: 'no_match', reason: 'corridor_unsupported' });
    } finally {
      await db.query(`UPDATE corridors SET enabled = true WHERE id = 'de-eur'`);
      await db.query(
        `UPDATE offers SET currency = 'USD' WHERE id = 'ofr_harbour-ledger_harbour-fees'`,
      );
    }
  });

  it('never substitutes: a no-match carries only kind and reason', async () => {
    for (const code of ['dock-history', 'draft-weather-notes']) {
      expect(Object.keys(noMatch(await run(code))).sort()).toEqual(['kind', 'reason']);
    }
  });

  it('the clock decides expiry: the quote expires 15 minutes after the injected now', async () => {
    expect(T0).toBe('2026-10-21T10:00:00.000Z');
    const q = quote(await run('tide-tables'));
    expect(Date.parse(q.expires_at) - Date.parse(T0)).toBe(15 * 60_000);
  });
});
