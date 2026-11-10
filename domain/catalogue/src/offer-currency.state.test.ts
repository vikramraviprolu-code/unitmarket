// OFFER-CUR (docs/specs/catalogue-offer-currency.md): the seller chooses the currency of an offer. Today's rows
// (US and IN covered by USD only) must answer exactly as before; the rows of the coming migration 0034 are
// simulated by inserting wide corridors, so this lane can ship first. The default never comes from `ORDER BY id`.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import {
  createOffer,
  listAuthorisedOffers,
  listOwnOffers,
  offerCurrenciesFor,
  offerCurrencyFor,
} from './index';
import { publishBatch } from './import-publish';
import { runNextBatch, startVerifiedImport } from './import-stage';
import { SOURCE_URL, importWorld, itemRows, shopPages, verifyShop } from './import-support';
import type { ImportWorld } from './import-support';
import { addArticle, offersWorld, versionsOf } from './write-support';
import type { OffersWorld } from './write-support';
import { addPublisher, installWideCorridors } from './wide-corridors-support';

const fixture = (name: string): string =>
  readFileSync(new URL(`../test-data/${name}`, import.meta.url), 'utf8');

const both = (keep: number, online: number) => [
  { option: 'keep_retrieve' as const, price_minor: keep },
  { option: 'online_read' as const, price_minor: online },
];

let w: OffersWorld;
let fr: Actor;
let india: Actor;
let n = 0;
beforeEach(async () => {
  w = await offersWorld();
  fr = { kind: 'publisher', publisher_id: await addPublisher(w.db, 'paris-desk', 'FR') };
  india = { kind: 'publisher', publisher_id: await addPublisher(w.db, 'delhi-desk', 'IN') };
});
afterEach(async () => {
  await w.db.close();
});

const make = async (actor: Actor, currency?: unknown) => {
  if (actor.kind !== 'publisher') throw new Error('publisher expected');
  n += 1;
  const article_id = await addArticle(w.db, actor.publisher_id, `oc-${String(n)}`);
  const r = await createOffer(w.deps(), actor, {
    article_id,
    options: both(150, 100),
    attestation: true,
    ...(currency === undefined ? {} : { currency: currency as string }),
  });
  return { r, article_id };
};
const currencyOf = async (offer_id: string): Promise<string> =>
  (await versionsOf(w.db, offer_id))[0]!.currency;

describe('today: only USD covers US and IN (no data change)', () => {
  beforeEach(async () => {
    // models today's live data: migration 0034 made the rows wide, so narrow them back here
    await w.db.query(
      "UPDATE corridors SET enabled = false WHERE id <> 'us-usd' AND id <> 'in-usd'",
    );
    await w.db.query("UPDATE corridors SET payee_countries = ARRAY['US'] WHERE id = 'us-usd'");
  });
  it('a US publisher with no currency gets USD', async () => {
    const { r } = await make(w.harbour);
    if (!r.ok) throw new Error(r.error.code);
    expect(await currencyOf(r.value.offer_id)).toBe('USD');
    expect(await offerCurrenciesFor(w.db, w.harbour)).toEqual(['USD']);
    expect(await offerCurrencyFor(w.db, w.harbour)).toBe('USD');
  });
  it('an IN publisher with no currency gets USD, and asking for USD gives the same', async () => {
    const a = await make(india);
    const b = await make(india, 'USD');
    if (!a.r.ok || !b.r.ok) throw new Error('refused');
    expect(await currencyOf(a.r.value.offer_id)).toBe('USD');
    expect(await currencyOf(b.r.value.offer_id)).toBe('USD');
    expect(await offerCurrenciesFor(w.db, india)).toEqual(['USD']);
  });
  it('EUR and GBP are no_corridor for US and IN publishers', async () => {
    for (const actor of [w.harbour, india])
      for (const c of ['EUR', 'GBP'])
        expect((await make(actor, c)).r).toEqual({ ok: false, error: { code: 'no_corridor' } });
  });
  it('a publisher country with no enabled corridor is still no_corridor, and has no currencies', async () => {
    expect((await make(fr)).r).toEqual({ ok: false, error: { code: 'no_corridor' } });
    expect(await offerCurrenciesFor(w.db, fr)).toEqual([]);
    expect(await offerCurrencyFor(w.db, fr)).toBeNull();
  });
  it('a buyer, an operator and the system have no currencies', async () => {
    for (const a of [w.buyer, w.operator, w.system])
      expect(await offerCurrenciesFor(w.db, a)).toBeNull();
  });
});

describe('with the rows of migration 0034 (simulated)', () => {
  beforeEach(async () => {
    await installWideCorridors(w.db);
  });

  it('the covered currencies are listed USD, EUR, GBP for a US, an FR and an IN publisher', async () => {
    for (const a of [w.harbour, fr, india])
      expect(await offerCurrenciesFor(w.db, a)).toEqual(['USD', 'EUR', 'GBP']);
    expect(await offerCurrencyFor(w.db, w.harbour)).toBe('USD');
  });

  it('with no currency the offer is USD for US, FR and IN publishers, never EUR (not by corridor id)', async () => {
    for (const a of [w.harbour, fr, india]) {
      const { r } = await make(a);
      if (!r.ok) throw new Error(r.error.code);
      expect(await currencyOf(r.value.offer_id)).toBe('USD');
    }
  });

  it.each(['USD', 'EUR', 'GBP'])(
    'an explicit %s is the currency of the offer, for US, FR and IN',
    async (c) => {
      for (const a of [w.harbour, fr, india]) {
        const { r } = await make(a, c);
        if (!r.ok) throw new Error(r.error.code);
        expect(await currencyOf(r.value.offer_id)).toBe(c);
      }
    },
  );

  it('the audit row names the chosen currency', async () => {
    const { r } = await make(fr, 'GBP');
    if (!r.ok) throw new Error(r.error.code);
    const a = await w.db.query<{ detail: { currency: string } }>(
      "SELECT detail FROM audit_log WHERE action = 'offer.created' AND target = $1",
      [r.value.offer_id],
    );
    expect(a.rows[0]!.detail.currency).toBe('GBP');
  });

  it('a currency with no covering corridor is no_corridor: wrong shape, wrong type, not offered', async () => {
    for (const bad of ['JPY', 'eur', 'EURO', '', 123, null, ['EUR']])
      expect((await make(w.harbour, bad)).r, String(bad)).toEqual({
        ok: false,
        error: { code: 'no_corridor' },
      });
  });

  it('a disabled corridor is not a choice: EUR off gives no_corridor for EUR and keeps the USD default', async () => {
    await w.db.query("UPDATE corridors SET enabled = false WHERE currency = 'EUR'");
    expect(await offerCurrenciesFor(w.db, w.harbour)).toEqual(['USD', 'GBP']);
    expect((await make(w.harbour, 'EUR')).r).toEqual({ ok: false, error: { code: 'no_corridor' } });
    const d = await make(w.harbour);
    if (!d.r.ok) throw new Error(d.r.error.code);
    expect(await currencyOf(d.r.value.offer_id)).toBe('USD');
  });

  it('an India publisher cannot sell in EUR while in-eur is off, though de-eur is on', async () => {
    await w.db.query("UPDATE corridors SET enabled = false WHERE id = 'in-eur'");
    expect(await offerCurrenciesFor(w.db, india)).toEqual(['USD', 'GBP']);
    expect((await make(india, 'EUR')).r).toEqual({ ok: false, error: { code: 'no_corridor' } });
  });

  it('when USD is off the default falls to EUR, then GBP', async () => {
    await w.db.query("UPDATE corridors SET enabled = false WHERE currency = 'USD'");
    const e = await make(w.harbour);
    if (!e.r.ok) throw new Error(e.r.error.code);
    expect(await currencyOf(e.r.value.offer_id)).toBe('EUR');
    await w.db.query("UPDATE corridors SET enabled = false WHERE currency = 'EUR'");
    const g = await make(w.harbour);
    if (!g.r.ok) throw new Error(g.r.error.code);
    expect(await currencyOf(g.r.value.offer_id)).toBe('GBP');
  });

  it('the new offers show in the own list with their currency and in the authorised list of their corridor', async () => {
    const e = await make(fr, 'EUR');
    const g = await make(fr, 'GBP');
    if (!e.r.ok || !g.r.ok) throw new Error('refused');
    const own = (await listOwnOffers(w.db, fr)) ?? [];
    expect(Object.fromEntries(own.map((o) => [o.offer_id, o.currency]))).toMatchObject({
      [e.r.value.offer_id]: 'EUR',
      [g.r.value.offer_id]: 'GBP',
    });
    const inEur = (await listAuthorisedOffers(w.db, { corridor_id: 'de-eur', limit: 100 })).map(
      (v) => v.offer.id,
    );
    expect(inEur).toContain(e.r.value.offer_id);
    expect(inEur).not.toContain(g.r.value.offer_id);
  });
});

describe('the web import keeps the deterministic default (per batch currency is a later lane)', () => {
  it('on the wide rows an India publisher stages and publishes in USD, not EUR', async () => {
    const iw: ImportWorld = await importWorld(shopPages(fixture));
    try {
      await installWideCorridors(iw.db);
      const id = await addPublisher(iw.db, 'delhi-import', 'IN');
      const actor: Actor = { kind: 'publisher', publisher_id: id };
      await verifyShop(iw, actor);
      const b = await startVerifiedImport(iw.idep(), actor, { source_url: SOURCE_URL });
      if (!b.ok) throw new Error(`begin refused: ${b.error.code}`);
      await runNextBatch(iw.idep());
      const rows = await itemRows(iw.db, b.value.batch_id);
      const live = rows.filter((r) => r.state !== 'refused');
      expect(live.length).toBeGreaterThan(0);
      expect(new Set(live.map((r) => r.currency))).toEqual(new Set(['USD']));
      const done = await publishBatch(iw.idep(), actor, {
        batch_id: b.value.batch_id,
        attestation: true,
      });
      expect(done.ok).toBe(true);
      const offers = await iw.db.query<{ currency: string }>(
        'SELECT currency FROM offers WHERE publisher_id = $1',
        [id],
      );
      expect(offers.rows.length).toBeGreaterThan(0);
      expect(new Set(offers.rows.map((o) => o.currency))).toEqual(new Set(['USD']));
    } finally {
      await iw.db.close();
    }
  });
});
