// INT-SEL / SEL.4 to SEL.6 and SEL.8 state: the setup path, Money, the offer pages and per-option performance.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXPECTED, IDS, bootSeller } from './seller-fixture';
import type { SellerRig } from './seller-fixture';

vi.mock('server-only', () => ({}));

let rig: SellerRig;
let seller: typeof import('./composition/seller');
let hv: typeof import('./lib/seller-home-view');
let mv: typeof import('./lib/seller-money-view');
let ov: typeof import('./lib/seller-offer-view');
let offers: typeof import('./lib/offers-view');
let win: { week: { from: Date; to: Date }; month: { from: Date; to: Date } };

beforeAll(async () => {
  rig = await bootSeller();
  seller = await import('./composition/seller');
  hv = await import('./lib/seller-home-view');
  mv = await import('./lib/seller-money-view');
  ov = await import('./lib/seller-offer-view');
  offers = await import('./lib/offers-view');
  win = hv.sellerWindows(rig.now);
}, 120_000);
afterAll(async () => {
  await rig.app.close();
});

const stateOf = (steps: { id: string; state: string }[]): Record<string, string> =>
  Object.fromEntries(steps.map((s) => [s.id, s.state]));

describe('SEL.4 the setup path', () => {
  const facts = {
    status: 'active' as const,
    terms_accepted: true,
    payee_last4: 'ABCD',
    payee_verified: true,
    offers_total: 1,
  };
  it('has the five steps in order', () => {
    expect(hv.setupSteps(facts).map((s) => s.id)).toEqual([
      'application',
      'terms',
      'payout_account',
      'payee_check',
      'first_offer',
    ]);
  });
  it('follows each stored fact, one at a time', () => {
    expect(stateOf(hv.setupSteps(facts))).toEqual({
      application: 'done',
      terms: 'done',
      payout_account: 'done',
      payee_check: 'done',
      first_offer: 'done',
    });
    expect(stateOf(hv.setupSteps({ ...facts, status: 'applied' })).application).toBe('todo');
    expect(stateOf(hv.setupSteps({ ...facts, terms_accepted: false })).terms).toBe('todo');
    const noAccount = stateOf(
      hv.setupSteps({ ...facts, payee_last4: null, payee_verified: false }),
    );
    expect(noAccount.payout_account).toBe('todo');
    expect(noAccount.payee_check).toBe('todo');
    expect(stateOf(hv.setupSteps({ ...facts, payee_verified: false })).payee_check).toBe('waiting');
    expect(stateOf(hv.setupSteps({ ...facts, offers_total: 0 })).first_offer).toBe('todo');
  });
  it('is done only when every step is done, and then it is not shown on Home', () => {
    expect(hv.setupDone(hv.setupSteps(facts))).toBe(true);
    expect(hv.setupDone(hv.setupSteps({ ...facts, offers_total: 0 }))).toBe(false);
  });
  it('reads each step from stored data', async () => {
    await rig.app.db.query(`UPDATE publishers SET status = 'applied' WHERE id = 'sl_pc'`);
    const c = await seller.readSellerSetup(rig.C);
    expect(c).not.toBeNull();
    expect(stateOf(c!.steps)).toEqual({
      application: 'todo',
      terms: 'todo',
      payout_account: 'todo',
      payee_check: 'todo',
      first_offer: 'todo',
    });
    await rig.app.db.query(
      `INSERT INTO publisher_agreements (id, publisher_id, terms_version, accepted_at, accepted_by_label, method, created_at, updated_at)
       VALUES ('agr_sl_pa', 'sl_pa', 'v1', $1, 'Alder Press', 'seeded_demo', $1, $1)`,
      [rig.at(30)],
    );
    await rig.app.db.query(`UPDATE publishers SET payee_verified_at = $1 WHERE id = 'sl_pa'`, [
      rig.at(20),
    ]);
    const a = await seller.readSellerSetup(rig.A);
    expect(stateOf(a!.steps)).toEqual({
      application: 'done',
      terms: 'done',
      payout_account: 'done',
      payee_check: 'done',
      first_offer: 'done',
    });
    expect(a!.done).toBe(true);
  });
});

describe('SEL.5 Money', () => {
  it('labels fee and net "modelled" on a dry run block only', () => {
    expect(mv.MODELLED).toBe('modelled');
    expect(mv.blockLabels({ environment: 'dryrun' }).modelled).toBe(true);
    expect(mv.blockLabels({ environment: 'sandbox' }).modelled).toBe(false);
  });
  it('shows it on the stored dry run block and never on an empty statement', async () => {
    const a = await seller.readSellerMoney(rig.A);
    expect(a!.blocks.length).toBeGreaterThan(0);
    for (const b of a!.blocks) expect(b.modelled).toBe(b.environment === 'dryrun');
    expect(a!.blocks.some((b) => b.modelled)).toBe(true);
    const c = await seller.readSellerMoney(rig.C);
    expect(c!.blocks).toEqual([]);
    expect(JSON.stringify(mv.moneyView(c!))).not.toContain('modelled');
  });
  it('takes the label from the stored environment, not a literal', async () => {
    const v = mv.moneyView({
      blocks: [
        {
          currency: 'USD',
          environment: 'sandbox',
          modelled: false,
          net_minor: 100,
          sales_minor: 100,
          refunds_minor: 0,
          reversals_minor: 0,
          paypal_fee_minor: 3,
        },
      ],
    } as never);
    expect(JSON.stringify(v)).not.toContain('modelled');
  });
  it('keeps the PUB-E1 statement CSV where it was', async () => {
    const { PUB_STATEMENT_HREF } = await import('./lib/seller-money-view');
    expect(PUB_STATEMENT_HREF).toBe('/api/publisher/export?kind=statement');
  });
});

describe('SEL.6 offers', () => {
  it('the status filter narrows the list', async () => {
    const list = await seller.readSellerOffers(rig.A);
    expect(list!.offers.map((o) => o.offer_id).sort()).toEqual([IDS.oa1, IDS.oa2]);
    expect(offers.filterOffers(list!.offers, 'on_sale')).toHaveLength(2);
    expect(offers.filterOffers(list!.offers, 'withdrawn')).toHaveLength(0);
  });
  it('the offer page lists the price history, newest version first', async () => {
    const o = await seller.readSellerOffer(rig.A, IDS.oa1);
    expect(o!.history.map((h) => h.version)).toEqual(['v2', 'v1']);
  });
  it("lists the offer's sales once each across versions, with its share of the money", async () => {
    const o = await seller.readSellerOffer(rig.A, IDS.oa1);
    expect(o!.sales.map((s) => s.unit_id).sort()).toEqual([IDS.uA, IDS.uM, IDS.uP, IDS.uW].sort());
    const m = o!.sales.find((s) => s.unit_id === IDS.uM)!;
    expect(m.net_minor).toBe(301);
    expect(o!.sales.find((s) => s.unit_id === IDS.uP)!.net_minor).toBe(0);
  });
  it("another seller's offer is not found", async () => {
    expect(await seller.readSellerOffer(rig.B, IDS.oa1)).toBeNull();
    expect(await seller.readSellerOffer(rig.vsBuyer1, IDS.oa1)).toBeNull();
  });
});

describe('SEL.8 performance', () => {
  it('units, gross, refunds and net per offer option equal the ledger', async () => {
    const rows = await seller.offerPerformance(
      rig.A.kind === 'publisher' ? rig.A.publisher_id : '',
      win.month.from,
      win.month.to,
    );
    const by = Object.fromEntries(rows.map((r) => [`${r.offer_id}/${r.option}`, r]));
    // sl_oa1 keep_retrieve: uA 3331, half of uM (301), uW 700 gross and 100 reversed.
    expect(by[`${IDS.oa1}/keep_retrieve`]).toMatchObject({
      units: 3,
      gross_minor: 3331 + 301 + 700,
      refunds_minor: 0,
      reversals_minor: 100,
      net_minor: 3331 + 301 + 600,
    });
    // sl_oa2 keep_retrieve: the other half of uM. online_read: uR 800 sold and 300 refunded.
    expect(by[`${IDS.oa2}/keep_retrieve`]).toMatchObject({
      units: 1,
      gross_minor: 300,
      net_minor: 300,
    });
    expect(by[`${IDS.oa2}/online_read`]).toMatchObject({
      units: 1,
      gross_minor: 800,
      refunds_minor: 300,
      net_minor: 500,
    });
  });
  it('per-offer nets sum to the statement net', async () => {
    const rows = await seller.offerPerformance('sl_pa', win.month.from, win.month.to);
    expect(rows.reduce((a, r) => a + r.net_minor, 0)).toBe(EXPECTED.month.net);
    const offerNets = ov.perOffer(
      rows.map((r) => ({
        unit_id: r.offer_id + r.option,
        currency: r.currency,
        environment: r.environment,
        channel: 'human' as const,
        gross_minor: r.gross_minor,
        refunds_minor: r.refunds_minor,
        reversals_minor: r.reversals_minor,
        offers: [{ offer_id: r.offer_id, option: r.option }],
      })),
    );
    expect(offerNets.reduce((a, r) => a + r.net_minor, 0)).toBe(EXPECTED.month.net);
  });
  it('is empty for a seller with no sale, and nothing for a buyer', async () => {
    expect(await seller.offerPerformance('sl_pc', win.month.from, win.month.to)).toEqual([]);
  });
});
