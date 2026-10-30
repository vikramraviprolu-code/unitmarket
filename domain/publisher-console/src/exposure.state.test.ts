// PUB-D: the operator's exposure read model, S7. PGlite with synthetic rows of three publishers, two
// currencies, captured, partly refunded, held and open refunds. Counts and sums only: no figure is
// projected, and nothing names a buyer or a whole merchant id.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publisherExposure } from './exposure';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
const AT = '2026-10-22T12:00:00.000Z';
const OP = { kind: 'operator', operator_id: 'opr_x', mfa: true } as const;

async function offer(
  id: string,
  publisher: string,
  article: string,
  over: Record<string, unknown> = {},
): Promise<void> {
  await w.insert('offers', {
    id,
    version: 'v1',
    publisher_id: publisher,
    article_id: article,
    status: 'authorised',
    currency: 'USD',
    options: JSON.stringify([
      { option: 'keep_retrieve', price_minor: 500, policy_id: 'p', policy_version: '1' },
    ]),
    affordability: JSON.stringify({ renegotiation_allowed: false, floor_minor: null }),
    terms_version: 't1',
    rights: '{}',
    valid_from: '2026-10-01T00:00:00.000Z',
    valid_until: null,
    superseded_by: null,
    ...over,
  });
  if ((over['status'] ?? 'authorised') === 'authorised') {
    await w.insert('publisher_authorisations', {
      id: `pau_${id}`,
      offer_id: id,
      offer_version: 'v1',
      authorised_by: publisher,
      at: '2026-10-01T00:00:00.000Z',
    });
  }
}

beforeAll(async () => {
  w = await makeWorld();
  await w.insert('publishers', {
    id: 'pub_3',
    slug: 'p3',
    display_name: 'Pub Zero',
    country: 'US',
    paypal_merchant_id: null,
    payee_verified_at: null,
    status: 'applied',
  });
  await w.db.query("UPDATE publishers SET status = 'suspended' WHERE id = 'pub_2'");
  // pub_1, USD: paid 500, partly refunded 400 (150 back), pending 300, declined 100 (counts nowhere).
  await w.unit({ n: 1, publisher: 'pub_1', amount_minor: 500 });
  await w.unit({ n: 2, publisher: 'pub_1', amount_minor: 400, status: 'partially_refunded' });
  await w.db.query("UPDATE order_units SET refunded_minor = 150 WHERE id = 'unt_2'");
  await w.unit({ n: 3, publisher: 'pub_1', amount_minor: 300, status: 'pending', captured: false });
  await w.unit({
    n: 4,
    publisher: 'pub_1',
    amount_minor: 100,
    status: 'declined',
    captured: false,
  });
  // pub_1, EUR: paid 700.
  await w.unit({ n: 5, publisher: 'pub_1', amount_minor: 700, currency: 'EUR' });
  // pub_2, USD: paid 1000, reversal suspected 250, mismatch 125.
  await w.unit({ n: 6, publisher: 'pub_2', amount_minor: 1000, buyer: 'buy_2' });
  await w.unit({
    n: 7,
    publisher: 'pub_2',
    amount_minor: 250,
    status: 'reversal_suspected',
    buyer: 'buy_2',
  });
  await w.unit({
    n: 8,
    publisher: 'pub_2',
    amount_minor: 125,
    status: 'mismatch',
    captured: false,
    buyer: 'buy_2',
  });
  // Refund requests: open ones count, final ones do not.
  const rq = async (id: string, unit: string, minor: number, state: string, cur = 'USD') =>
    w.insert('refund_requests', {
      id,
      unit_id: unit,
      capture_id: `CAP${unit.slice(4)}`,
      amount_minor: minor,
      currency: cur,
      reason: 'test',
      requested_by: 'opr_x',
      state,
      refund_id: null,
    });
  await rq('rfr_1', 'unt_1', 200, 'requested');
  await rq('rfr_2', 'unt_2', 150, 'completed');
  await rq('rfr_3', 'unt_5', 50, 'unresolved', 'EUR');
  await rq('rfr_4', 'unt_6', 80, 'cancelled');
  await rq('rfr_5', 'unt_6', 90, 'failed');
  // Offers: pub_1 has one live USD offer and one live EUR offer (both corridors enabled for US payees),
  // one withdrawn and one superseded. pub_2 is suspended, so its authorised offer is not live.
  await offer('ofr_1', 'pub_1', 'art_1');
  await offer('ofr_2', 'pub_1', 'art_2', { currency: 'EUR' });
  await offer('ofr_3', 'pub_1', 'art_3', { status: 'withdrawn' });
  await offer('ofr_4', 'pub_1', 'art_4', { superseded_by: 'ofr_1' });
  await offer('ofr_5', 'pub_2', 'art_6');
});
afterAll(async () => {
  await w.close();
});

describe('publisherExposure', () => {
  it('gives one row per publisher, by name, with status, payee last 4 and the verified flag', async () => {
    const rows = (await publisherExposure(w.db, OP, AT))!;
    expect(rows.map((r) => [r.slug, r.display_name, r.status])).toEqual([
      ['p1', 'Pub One', 'active'],
      ['p2', 'Pub Two', 'suspended'],
      ['p3', 'Pub Zero', 'applied'],
    ]);
    expect(rows.map((r) => r.payee_last4)).toEqual(['001A', '002B', null]);
    expect(rows.map((r) => r.payee_verified_at !== null)).toEqual([true, true, false]);
    expect(rows.map((r) => r.payee_shared)).toEqual([false, false, false]);
    expect(rows[0]!.publisher_id).toBe('pub_1');
  });

  it('counts offers live by the discovery rule: authorised, newest, not superseded, active publisher', async () => {
    const rows = (await publisherExposure(w.db, OP, AT))!;
    expect(rows.map((r) => r.offers_live)).toEqual([2, 0, 0]);
  });

  it('adds up per currency: captured not refunded, open refunds, held units', async () => {
    const rows = (await publisherExposure(w.db, OP, AT))!;
    expect(rows[0]!.by_currency).toEqual([
      {
        currency: 'EUR',
        environment: 'dryrun',
        units_captured: 1,
        captured_not_refunded_minor: 700,
        refunds_open_count: 1,
        refunds_open_minor: 50,
        held_count: 0,
        held_minor: 0,
      },
      {
        currency: 'USD',
        environment: 'dryrun',
        units_captured: 2,
        captured_not_refunded_minor: 750,
        refunds_open_count: 1,
        refunds_open_minor: 200,
        held_count: 1,
        held_minor: 300,
      },
    ]);
    expect(rows[1]!.by_currency).toEqual([
      {
        currency: 'USD',
        environment: 'dryrun',
        units_captured: 1,
        captured_not_refunded_minor: 1000,
        refunds_open_count: 0,
        refunds_open_minor: 0,
        held_count: 2,
        held_minor: 375,
      },
    ]);
    expect(rows[2]!.by_currency).toEqual([]);
  });

  it('keeps dry run rows apart from sandbox rows of the same currency', async () => {
    await w.unit({ n: 20, publisher: 'pub_1', amount_minor: 60, environment: 'sandbox' });
    const rows = (await publisherExposure(w.db, OP, AT))!;
    const usd = rows[0]!.by_currency.filter((b) => b.currency === 'USD');
    expect(
      usd.map((b) => [b.environment, b.units_captured, b.captured_not_refunded_minor]),
    ).toEqual([
      ['dryrun', 2, 750],
      ['sandbox', 1, 60],
    ]);
  });

  it('answers null to every actor but an operator with the second factor', async () => {
    for (const actor of [
      { kind: 'operator', operator_id: 'opr_x', mfa: false },
      { kind: 'publisher', publisher_id: 'pub_1' },
      { kind: 'buyer', buyer_id: 'buy_1' },
      { kind: 'system' },
    ] as const) {
      expect(await publisherExposure(w.db, actor, AT)).toBeNull();
    }
  });

  it('names no buyer, no order reference and no whole merchant id', async () => {
    const text = JSON.stringify(await publisherExposure(w.db, OP, AT));
    for (const secret of [
      'Ann Buyer',
      'Bob Buyer',
      'buy_1',
      'buy_2',
      'sub_a',
      'sub_b',
      'ordref_',
      'MERCHANT0001A',
      'MERCHANT0002B',
    ])
      expect(text).not.toContain(secret);
  });

  it('only reads: no row changes', async () => {
    const before = (await w.db.query<{ n: string }>('SELECT count(*) AS n FROM order_units'))
      .rows[0]!.n;
    await publisherExposure(w.db, OP, AT);
    const after = (await w.db.query<{ n: string }>('SELECT count(*) AS n FROM order_units'))
      .rows[0]!.n;
    expect(after).toBe(before);
  });
});
