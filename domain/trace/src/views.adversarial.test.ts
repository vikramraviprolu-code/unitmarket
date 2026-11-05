// INT-TR1 / TR1.2: who sees what. Buyer B reading buyer A's order gets what an unknown ref gets; an agent key
// reads its own buyer's timeline in the buyer view; seller A on a two-seller order sees nothing of seller B
// and nothing of the buyer; the operator key answer and the session answer without the second factor hold
// no identity; the session answer with it does.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyerTimeline, operatorView, opsTimeline, sellerTimeline } from './index';
import { CANARY, freshDb, scan, seedWorld } from './support';
import type { Db, World } from './support';

let db: Db;
let w: World;
beforeAll(async () => {
  db = await freshDb();
  w = await seedWorld(db);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe('buyer view', () => {
  it('buyer B reading buyer A order gets null, the same as an unknown ref', async () => {
    const other = await buyerTimeline(db, { order_ref: w.order_ref, buyer_id: w.buyer_2 });
    const unknown = await buyerTimeline(db, {
      order_ref: 'ref_does_not_exist',
      buyer_id: w.buyer_2,
    });
    expect(other).toBeNull();
    expect(unknown).toBeNull();
    expect(
      await buyerTimeline(db, { order_ref: w.other_order_ref, buyer_id: w.buyer_1 }),
    ).toBeNull();
  });
  it('labels the actors as the buyer may read them and shows no context, operator id or provider id', async () => {
    const t = (await buyerTimeline(db, { order_ref: w.order_ref, buyer_id: w.buyer_1 }))!;
    const labels = new Set(t.entries.map((e) => e.actor.label));
    expect(labels).toEqual(new Set(['You', 'PayPal', 'UnitMarket', 'Your agent (key …1234)']));
    const text = scan(t);
    for (const bad of [
      'opr_1',
      'req_t1',
      'cccccccc',
      'ip_hash',
      'trace_context',
      'api_key_id',
      'PPORDER',
      'CAPA',
      'RFD_A',
      'key_wxyz1234',
      'mandate',
      'man_1',
    ]) {
      expect(text, bad).not.toContain(bad);
    }
    expect(Object.keys(t.entries[0]!)).not.toContain('details');
  });
  it('an agent key sees its own buyer view (never operator context), and not another buyer', async () => {
    // The agent key acts as buyer buy_1: the same call, with the principal buyer.
    const mine = await buyerTimeline(db, { order_ref: w.order_ref, buyer_id: w.buyer_1 });
    expect(mine!.entries.length).toBeGreaterThan(10);
    expect(
      await buyerTimeline(db, { order_ref: w.other_order_ref, buyer_id: w.buyer_1 }),
    ).toBeNull();
  });
  it('hides what is internal to the operator: provider calls, webhooks, alerts, ledger fees', async () => {
    const t = (await buyerTimeline(db, { order_ref: w.order_ref, buyer_id: w.buyer_1 }))!;
    for (const e of t.entries) {
      expect([
        'provider_calls',
        'webhook_events',
        'alerts',
        'ledger_entries',
        'operations',
        'provider_orders',
      ]).not.toContain(e.source.table);
    }
  });
});

describe('seller view on a two-seller order', () => {
  it('seller A sees only unit A, no total, no unit or amount of seller B, no buyer', async () => {
    const t = (await sellerTimeline(db, { unit_id: w.unit_a, publisher_id: w.pub_a }))!;
    expect(t).not.toBeNull();
    expect(t.entries.length).toBeGreaterThan(5);
    const text = scan(t);
    for (const bad of [
      'total_minor',
      'unt_b',
      'ent_b',
      'led_b',
      'aev_b',
      'pvo_b',
      'pub_b',
      'MERCH_B',
      'buy_1',
      'buy_2',
      CANARY.buyerName,
      CANARY.buyerSub,
      'key_wxyz1234',
      'man_1',
      'ctx_',
      'req_t1',
      'rct_1',
      'ord_1',
    ]) {
      expect(text, bad).not.toContain(bad);
    }
    const amounts = t.entries.map((e) => e.amount_minor).filter((a) => a !== undefined);
    expect(amounts).not.toContain(200);
    expect(amounts).not.toContain(700);
    expect(amounts).toContain(500);
    const labels = new Set(t.entries.map((e) => e.actor.label));
    for (const l of labels) expect(['Buyer', "Buyer's agent", 'UnitMarket', 'PayPal']).toContain(l);
    expect(labels.has("Buyer's agent")).toBe(true);
  });
  it('order level events carry only this seller unit and amount', async () => {
    const t = (await sellerTimeline(db, { unit_id: w.unit_a, publisher_id: w.pub_a }))!;
    const order = t.entries.filter((e) => e.event_type.startsWith('orders.'));
    expect(order.length).toBeGreaterThan(0);
    for (const e of order) {
      expect(e.source).toEqual({ table: 'order_units', id: 'unt_a' });
      expect(e.amount_minor === undefined || e.amount_minor === 500).toBe(true);
    }
  });
  it('seller A reading seller B unit, or an unknown unit, gets null with one shape', async () => {
    expect(await sellerTimeline(db, { unit_id: w.unit_b, publisher_id: w.pub_a })).toBeNull();
    expect(await sellerTimeline(db, { unit_id: 'unt_nope', publisher_id: w.pub_a })).toBeNull();
  });
  it('seller B has the mirror view', async () => {
    const t = (await sellerTimeline(db, { unit_id: w.unit_b, publisher_id: w.pub_b }))!;
    const text = scan(t);
    for (const bad of ['unt_a', 'rfr_a', 'pub_a', 'MERCH_A', 'buy_1', 'total_minor'])
      expect(text, bad).not.toContain(bad);
    expect(t.entries.map((e) => e.amount_minor)).not.toContain(500);
  });
});

describe('operator view', () => {
  it('the key answer and the session answer without MFA hold no identity, provider id, request id or address', async () => {
    const t = (await opsTimeline(db, { order_ref: w.order_ref, mfa: false }))!;
    const text = scan(t);
    for (const bad of [
      'buy_1',
      'buy_2',
      CANARY.buyerName,
      'PPORDERAAAA1234',
      'CAPA',
      'CAPB',
      'RFD_A',
      'req_t1',
      'cccccccc',
      'ip_hash',
      'ua_family',
      'api_key_id',
      'key_wxyz1234',
      'man_1',
    ]) {
      expect(text, bad).not.toContain(bad);
    }
    // provider ids appear as "…" and the last four characters
    expect(text).toContain('…1234');
    const hasJob = t.entries.some((e) => e.job === 'pass');
    expect(hasJob).toBe(true);
    const tool = t.entries.find((e) => e.tool === 'buy');
    expect(tool).toBeDefined();
    // the operator is named, the buyer is not
    const op = t.entries.find((e) => e.actor.kind === 'operator')!;
    expect(op.actor_id).toBe('opr_1');
    const buyerEntry = t.entries.find((e) => e.actor.kind === 'buyer')!;
    expect(buyerEntry.actor_id).toBeUndefined();
  });
  it('the session answer with MFA adds actor ids, provider ids, request id, an eight character address prefix, family, key and mfa', async () => {
    const t = (await opsTimeline(db, { order_ref: w.order_ref, mfa: true }))!;
    const text = scan(t);
    for (const want of ['buy_1', 'PPORDERAAAA1234', 'CAPA', 'RFD_A', 'req_t1', 'key_wxyz1234'])
      expect(text, want).toContain(want);
    expect(text).toContain('cccccccc');
    expect(text).not.toContain('c'.repeat(9));
    const agent = t.entries.find((e) => e.actor.kind === 'agent')!;
    expect(agent.api_key_id).toBe('key_wxyz1234');
    expect(agent.ua_family).toBe('sdk');
    expect(agent.mfa).toBe(false);
    const withMfa = t.entries.find((e) => e.actor.kind === 'operator')!;
    expect(withMfa.mfa).toBe(false); // the refund request was made without the code
    expect(text).not.toContain(CANARY.reason);
    expect(text).not.toContain(CANARY.secret);
  });
  it('operatorView is the one function that redacts, and it never lets a wider shape through', () => {
    const rich = [
      {
        at: '2026-11-04T09:00:00.000Z',
        seq: 1,
        event_type: 'orders.created',
        words_key: 'orders.created',
        actor: { kind: 'buyer' as const, label: 'Buyer' },
        channel: 'web' as const,
        source: { table: 'orders', id: 'ord_1' },
        verified: true,
        actor_id: 'buy_1',
        req_id: 'req_x',
        ip_hash: 'abcdef0123456789abcdef0123456789',
        ua_family: 'browser',
        api_key_id: 'key_1',
        mfa: false,
        job: null,
        tool: null,
        details: { capture_id: 'CAP12345', status: 'created' },
      },
    ];
    const lo = operatorView(rich, { mfa: false })[0]!;
    expect(lo).not.toHaveProperty('actor_id');
    expect(lo).not.toHaveProperty('req_id');
    expect(lo).not.toHaveProperty('ip_hash');
    expect(lo).not.toHaveProperty('api_key_id');
    expect(lo.details).toEqual({ capture_id: '…2345', status: 'created' });
    const hi = operatorView(rich, { mfa: true })[0]!;
    expect(hi.ip_hash).toBe('abcdef01');
    expect(hi.details).toEqual({ capture_id: 'CAP12345', status: 'created' });
    expect(hi.actor_id).toBe('buy_1');
  });
});
