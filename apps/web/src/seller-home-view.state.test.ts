// INT-SEL / SEL.3 and SEL.7 state: the seller Home after setup. This week's sales and net, what needs the seller,
// the top three offers, and the agent share. Windows come from the injected Clock in UTC (F4). Net is the
// statement net: gross minus refunds minus reversals, with the PayPal fee beside it and never subtracted (F3).
// A unit holding several articles counts toward each offer it holds, its money split evenly with the remainder
// to the lowest offer id (R2-1), and each (unit, offer id) pair counts once across offer versions (R2-2).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXPECTED, IDS, bootSeller } from './seller-fixture';
import type { SellerRig } from './seller-fixture';

vi.mock('server-only', () => ({}));

let rig: SellerRig;
let seller: typeof import('./composition/seller');
let hv: typeof import('./lib/seller-home-view');
let ov: typeof import('./lib/seller-offer-view');
let win: { week: { from: Date; to: Date }; month: { from: Date; to: Date } };

beforeAll(async () => {
  rig = await bootSeller();
  seller = await import('./composition/seller');
  hv = await import('./lib/seller-home-view');
  ov = await import('./lib/seller-offer-view');
  win = hv.sellerWindows(rig.now);
}, 120_000);
afterAll(async () => {
  await rig.app.close();
});

const id = (a: { publisher_id: string } | { kind: string }): string =>
  (a as { publisher_id: string }).publisher_id;

describe('windows (F4)', () => {
  it('are 7 and 30 days ending at now, in UTC', () => {
    const now = new Date('2026-11-05T13:08:15.000Z');
    const w = hv.sellerWindows(now);
    expect(w.week.to.toISOString()).toBe('2026-11-05T13:08:15.000Z');
    expect(w.week.from.toISOString()).toBe('2026-10-29T13:08:15.000Z');
    expect(w.month.from.toISOString()).toBe('2026-10-06T13:08:15.000Z');
    expect(w.month.to.toISOString()).toBe(w.week.to.toISOString());
  });
});

describe('splitting a unit across its offers (R2-1)', () => {
  it('splits evenly in minor units and gives the remainder to the lowest id', () => {
    expect([...ov.splitMinor(601, ['b', 'a']).entries()]).toEqual([
      ['a', 301],
      ['b', 300],
    ]);
    expect([...ov.splitMinor(602, ['c', 'a', 'b']).entries()]).toEqual([
      ['a', 202],
      ['b', 200],
      ['c', 200],
    ]);
    expect([...ov.splitMinor(5, ['a']).entries()]).toEqual([['a', 5]]);
    expect([...ov.splitMinor(0, ['a', 'b']).entries()]).toEqual([
      ['a', 0],
      ['b', 0],
    ]);
  });
  it('always sums back to the total', () => {
    for (const total of [0, 1, 2, 3, 99, 601, 100001]) {
      for (const n of [1, 2, 3, 7]) {
        const keys = Array.from({ length: n }, (_, i) => `k${String(i)}`);
        const sum = [...ov.splitMinor(total, keys).values()].reduce((a, b) => a + b, 0);
        expect(sum, `${String(total)} over ${String(n)}`).toBe(total);
      }
    }
  });
});

describe('agent share (SEL.3, SEL.7)', () => {
  it('is agent units over all units in the 30 day window', async () => {
    const s = await seller.agentShare(id(rig.A), win.month.from, win.month.to);
    expect(s).toEqual(EXPECTED.agent);
    expect(hv.agentShareView(s)).toEqual({
      empty: false,
      value: '25%',
      note: '1 of 4 sales in the last 30 days was bought by an agent.',
    });
  });
  it('counts a sale outside the window as nothing', async () => {
    const wide = await seller.agentShare(
      id(rig.A),
      new Date(rig.now.getTime() - 60 * 86_400_000),
      rig.now,
    );
    expect(wide.total_units).toBe(5);
  });
  it('shows words, never NaN or a blank, when there is no sale', async () => {
    const s = await seller.agentShare(id(rig.C), win.month.from, win.month.to);
    expect(s).toEqual({ agent_units: 0, total_units: 0 });
    const v = hv.agentShareView(s);
    expect(v.empty).toBe(true);
    expect(v.note).toBe('No sales in the last 30 days.');
    expect(JSON.stringify(v)).not.toMatch(/NaN|undefined|null/);
  });
});

describe('top offers (SEL.3, SEL.7)', () => {
  it('are ordered by net, count the multi-article unit toward each offer, and count each unit once per offer id', async () => {
    const top = await seller.topOffers(id(rig.A), win.month.from, win.month.to, 3);
    expect(top.map((t) => [t.offer_id, t.units, t.net_minor])).toEqual(
      EXPECTED.top.map((t) => [t.offer_id, t.units, t.net]),
    );
    // sl_oa1 has two versions; it is still one row, and its units are 3, not 6.
    expect(top.filter((t) => t.offer_id === IDS.oa1)).toHaveLength(1);
  });
  it('takes the first n only', async () => {
    const top = await seller.topOffers(id(rig.A), win.month.from, win.month.to, 1);
    expect(top.map((t) => t.offer_id)).toEqual([IDS.oa1]);
  });
  it('orders ties by offer id, ascending', () => {
    const rows = ['z', 'm', 'a'].map((offer_id) => ({
      unit_id: `u_${offer_id}`,
      currency: 'USD',
      environment: 'dryrun' as const,
      channel: 'human' as const,
      gross_minor: 100,
      refunds_minor: 0,
      reversals_minor: 0,
      offers: [{ offer_id, option: 'keep_retrieve' }],
    }));
    expect(ov.topOffersFrom(rows, 3).map((t) => t.offer_id)).toEqual(['a', 'm', 'z']);
  });
  it("sums to the statement net of the window's units", async () => {
    const top = await seller.topOffers(id(rig.A), win.month.from, win.month.to, 10);
    const total = top.reduce((a, t) => a + t.net_minor, 0);
    expect(total).toBe(EXPECTED.month.net);
    expect(total).toBe(await ledgerNet(win.month.from, win.month.to));
  });
});

/** The statement formula over the ledger, written independently of the code under test. */
async function ledgerNet(from: Date, to: Date): Promise<number> {
  const r = await rig.app.db.query<{ n: string | number }>(
    `SELECT coalesce(sum(CASE WHEN l.kind = 'sale' THEN l.amount_minor
                              WHEN l.kind IN ('refund', 'reversal') THEN -l.amount_minor ELSE 0 END), 0) AS n
       FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id
      WHERE u.publisher_id = 'sl_pa' AND u.captured_verified_at >= $1 AND u.captured_verified_at < $2`,
    [from.toISOString(), to.toISOString()],
  );
  return Number(r.rows[0]!.n);
}

describe('Home figures (SEL.3)', () => {
  it("this week's sales and net equal the ledger by the statement formula", async () => {
    const home = await seller.readSellerHome(rig.A);
    if (home === null) throw new Error('expected a home');
    expect(home.week).toMatchObject({
      currency: 'USD',
      environment: 'dryrun',
      units: EXPECTED.week.units,
      gross_minor: EXPECTED.week.gross,
      refunds_minor: EXPECTED.week.refunds,
      reversals_minor: EXPECTED.week.reversals,
      net_minor: EXPECTED.week.net,
    });
    expect(home.week!.net_minor).toBe(await ledgerNet(win.week.from, win.week.to));
  });

  it('carries the agent share, the top offers and what needs the seller', async () => {
    const home = await seller.readSellerHome(rig.A);
    if (home === null) throw new Error('expected a home');
    expect(home.agent).toEqual(EXPECTED.agent);
    expect(home.top.map((t) => t.offer_id)).toEqual([IDS.oa1, IDS.oa2]);
    expect(typeof home.needs_you).toBe('number');
  });

  it('turns the figures into words and tiles, with the fee beside the net and not taken from it', async () => {
    const home = await seller.readSellerHome(rig.A);
    if (home === null) throw new Error('expected a home');
    const v = hv.homeView(home);
    expect(v.week.kind).toBe('figures');
    if (v.week.kind === 'figures') {
      expect(v.week.units_text).toBe('3 sales this week');
      expect(v.week.net_text).toContain('44.32');
    }
    expect(v.top).toHaveLength(2);
    expect(v.top[0]!.title_note).toBeUndefined();
    expect(v.top_note).toBe('A sale with several articles counts toward each.');
    expect(v.agent.value).toBe('25%');
  });

  it('a seller with no sales sees words', async () => {
    const home = await seller.readSellerHome(rig.C);
    if (home === null) throw new Error('expected a home');
    expect(home.week).toBeNull();
    expect(home.top).toEqual([]);
    const v = hv.homeView(home);
    expect(v.week).toEqual({ kind: 'empty', text: 'No sales in the last 7 days.' });
    expect(v.top).toEqual([]);
    expect(v.top_empty).toBe('No sales in the last 30 days.');
    expect(v.agent.note).toBe('No sales in the last 30 days.');
    expect(JSON.stringify(v)).not.toMatch(/NaN|undefined/);
  });

  it('is nothing for a buyer, an operator or nobody', async () => {
    expect(await seller.readSellerHome(rig.vsBuyer1)).toBeNull();
    expect(await seller.readSellerHome(rig.operator)).toBeNull();
    expect(await seller.readSellerHome(null)).toBeNull();
  });
});
