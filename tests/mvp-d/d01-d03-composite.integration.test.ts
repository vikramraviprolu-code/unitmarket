// MVP-D offline acceptance D-01, D-02 and D-03 (mvp-plan MVP-D table; nfr.md P5 per unit, P11 per
// publisher). A buyer approves one pack of two publishers; the app places one order, creates one PayPal
// order per publisher, and captures each after its own approval. Everything goes through the route
// handlers and the engine of the real app, over the approved sandbox transport and a fake Wire that
// plays the dry-run order model; no byte leaves the process. The real half of D-01 (two sandbox
// captures) is an owner-window row; D-02 real is not attempted (D-042). Wording of banners and of the
// cancel page is not asserted here: DP-5b owns it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkInvariants } from '@umsbx/payments';
import {
  HAPPY_PACK_CALLS,
  HARBOUR_FERRY,
  HARBOUR_TIDE,
  QUAY_MARKET,
  QUAY_WALK,
  bootDRig,
  fingerprint,
  libraryOf,
  orderStatus,
  poStates,
  runPack,
  startPack,
} from './d-support';
import type { DRig } from './d-support';

vi.mock('server-only', () => ({}));

let rig: DRig;
beforeEach(async () => {
  rig = await bootDRig();
}, 60_000);
afterEach(async () => {
  await rig?.close();
});

const failing = async (): Promise<string[]> =>
  (await checkInvariants(rig.app.db)).filter((i) => !i.ok).map((i) => `${i.id}: ${i.detail}`);

/** The units of an order with the publisher's slug and the entitlements each one holds. */
const unitsOf = (order_id: string) =>
  rig.rows<{
    slug: string;
    position: number | string;
    status: string;
    capture_id: string | null;
    amount_minor: number | string;
    po_state: string;
    provider_order_id: string;
    access: string;
  }>(
    `SELECT pub.slug, p.position, u.status, u.capture_id, u.amount_minor, p.state AS po_state,
            p.provider_order_id, e.access_state AS access
       FROM order_units u
       JOIN provider_orders p ON p.id = u.provider_order_ref
       JOIN publishers pub ON pub.id = u.publisher_id
       JOIN entitlements e ON e.unit_id = u.id
      WHERE u.order_id = $1 ORDER BY p.position`,
    [order_id],
  );

describe('D-01 two_captures (offline twin of the real run)', () => {
  it('D-01 one approval for two publishers, two PayPal orders, two capture ids, one per publisher, per-item entitlements', async () => {
    const run = await runPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET], ['happy', 'happy']);

    // The first return leaves the pack waiting for the second approval; the second one pays it.
    expect(run.returns.map((r) => (r.ok ? r.value.status : r.error.code))).toEqual([
      'awaiting_buyer',
      'paid',
    ]);
    expect(await orderStatus(rig, run.order_id)).toBe('paid');
    expect(await poStates(rig, run.order_id)).toEqual(['captured', 'captured']);

    // One approval snapshot with two payments, one order.
    const view = await rig.app.engine.approvalView({ approval_id: run.approval_id, actor: rig.A });
    expect(view?.settlement).toEqual({ payments: 2 });
    expect(await rig.count('SELECT count(*) AS c FROM orders')).toBe(1);
    expect(await rig.count('SELECT count(*) AS c FROM approvals')).toBe(1);

    // Two units, one per publisher, each with its own capture id and PayPal order; both verified.
    const units = await unitsOf(run.order_id);
    expect(units.map((u) => u.slug).sort()).toEqual(['harbour-ledger', 'quayside-gazette']);
    const captureIds = units.map((u) => u.capture_id);
    expect(captureIds.every((c) => typeof c === 'string' && c.length > 0)).toBe(true);
    expect(new Set(captureIds).size).toBe(2);
    expect(new Set(units.map((u) => u.provider_order_id)).size).toBe(2);
    expect(units.every((u) => u.status === 'captured_verified')).toBe(true);
    const prices = Object.fromEntries(units.map((u) => [u.slug, Number(u.amount_minor)]));
    expect(prices['harbour-ledger']).toBeGreaterThan(0);
    expect(prices['quayside-gazette']).toBeGreaterThan(0);

    // Per-item entitlements: one per item, available, each on its own publisher's unit.
    expect(units.map((u) => u.access)).toEqual(['available', 'available']);
    expect(await rig.count('SELECT count(*) AS c FROM entitlements')).toBe(2);
    const lib = await libraryOf(rig, 'A');
    expect(lib.filter((l) => l.can_open).length).toBe(2);

    // The ledger: one sale per publisher, equal to its unit (P11 per publisher).
    const sales = await rig.rows<{ slug: string; amount_minor: number | string }>(
      `SELECT pub.slug, l.amount_minor FROM ledger_entries l
         JOIN order_units u ON u.id = l.unit_id JOIN publishers pub ON pub.id = u.publisher_id
        WHERE l.kind = 'sale'`,
    );
    expect(Object.fromEntries(sales.map((s) => [s.slug, Number(s.amount_minor)]))).toEqual(prices);
    expect(await failing()).toEqual([]);

    // One receipt for the order that names both publishers.
    const receipt = await rig.app.engine.receipt({ order_id: run.order_id, actor: rig.A });
    expect(receipt?.snapshot.items.length).toBe(2);
    expect(receipt?.snapshot.publishers.length).toBe(2);
  });

  it('D-01 the PayPal calls are those the owner steps count: 1 token, 2 creates with one unit and no payee, 7 reads, 2 captures', async () => {
    const run = await runPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET], ['happy', 'happy']);
    expect(rig.ops().length).toBe(HAPPY_PACK_CALLS);
    expect(rig.calls('oauth_token')).toBe(1);
    expect(rig.calls('create_order')).toBe(2);
    expect(rig.calls('get_order')).toBe(7);
    expect(rig.calls('capture_order')).toBe(2);
    expect(await rig.count('SELECT count(*) AS c FROM provider_calls')).toBe(HAPPY_PACK_CALLS);

    // The stop conditions of the owner steps, read off the request bodies the Wire saw.
    const creates = rig.sent
      .filter((s) => s.method === 'POST' && new URL(s.url).pathname === '/v2/checkout/orders')
      .map((s) => JSON.parse(s.body ?? '{}') as { purchase_units: Record<string, unknown>[] });
    expect(creates.length).toBe(2);
    for (const c of creates) {
      expect(c.purchase_units.length).toBe(1); // never one create with two units
      expect(c.purchase_units[0]).not.toHaveProperty('payee'); // the payee is left out (D-028, D-041)
    }
    const invoices = creates.map((c) => String(c.purchase_units[0]!['invoice_id']));
    expect(new Set(invoices).size).toBe(2);
    expect(invoices.map((i) => i.replace(run.order_ref, ''))).toEqual(['-p1', '-p2']);
    // No capture before both approvals: both PayPal orders were APPROVED at the model before any capture.
    const firstCapture = rig.ops().indexOf('capture_order');
    expect(
      rig
        .ops()
        .slice(0, firstCapture)
        .filter((o) => o === 'create_order').length,
    ).toBe(2);
    expect(rig.calls('capture_order')).toBe(2);
  });

  it('D-01 nothing is captured after only one approval', async () => {
    const placed = await startPack(rig, 'B', [HARBOUR_FERRY, QUAY_WALK]);
    const ok = rig.model.approve(placed.pos[0]!, 'happy');
    expect(ok).toBe(true);
    const r = await rig.app.engine.payments.onBuyerReturn({
      order_ref: placed.order_ref,
      actor: rig.B,
      scenario: null,
    });
    expect(r.ok && r.value.status).toBe('awaiting_buyer');
    expect(r.ok && r.value.next?.step).toBe(2);
    expect(rig.calls('capture_order')).toBe(0);
    expect(
      await rig.count(
        'SELECT count(*) AS c FROM order_units WHERE order_id = $1 AND capture_id IS NOT NULL',
        [placed.order_id],
      ),
    ).toBe(0);
    expect(await rig.count('SELECT count(*) AS c FROM ledger_entries')).toBe(0);
  });
});

describe('D-02 partial_capture', () => {
  it.each([
    ['the second PayPal order is declined', ['happy', 'declined']],
    ['the first PayPal order is declined', ['declined', 'happy']],
  ] as const)(
    'D-02 one captured, one declined (%s): paid_partial, the captured item available, the declined item locked and not charged, a case opened',
    async (_name, scenarios) => {
      const run = await runPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET], [...scenarios]);
      expect(await orderStatus(rig, run.order_id)).toBe('paid_partial');
      const declinedPos = scenarios.indexOf('declined');
      const states = await poStates(rig, run.order_id);
      expect(states[declinedPos]).toBe('declined');
      expect(states[1 - declinedPos]).toBe('captured');

      const units = await unitsOf(run.order_id);
      const good = units.find((u) => u.po_state === 'captured')!;
      const bad = units.find((u) => u.po_state === 'declined')!;
      expect(good.status).toBe('captured_verified');
      expect(good.access).toBe('available');
      expect(bad.status).toBe('declined');
      expect(bad.access).toBe('locked');

      // Not charged: the declined unit has no ledger row, only the captured one is booked.
      const booked = await rig.rows<{ slug: string; kind: string }>(
        `SELECT pub.slug, l.kind FROM ledger_entries l
           JOIN order_units u ON u.id = l.unit_id JOIN publishers pub ON pub.id = u.publisher_id
          WHERE l.kind = 'sale'`,
      );
      expect(booked.map((b) => b.slug)).toEqual([good.slug]);
      expect(
        await rig.count(
          'SELECT count(*) AS c FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.status = $1',
          ['declined'],
        ),
      ).toBe(0);
      expect(await rig.count('SELECT count(*) AS c FROM refund_requests')).toBe(0);

      // What the buyer sees, from stored facts: one item ready, one item not charged.
      const v = await rig.app.engine.orderView({ order_ref: run.order_ref, actor: rig.A });
      expect(v?.status).toBe('paid_partial');
      const kinds = Object.fromEntries((v?.items ?? []).map((i) => [i.publisher, i.kind]));
      expect(Object.values(kinds).sort()).toEqual(['declined', 'ready']);
      const lib = await libraryOf(rig, 'A');
      expect(lib.filter((l) => l.can_open).length).toBe(1);

      // The alert is raised once, for the PayPal order that is not charged; the case opens on a pass.
      const alerts = await rig.rows<{
        kind: string;
        detail: { reason?: string; not_charged?: number };
      }>(`SELECT kind, detail FROM alerts WHERE kind = 'partial_composite'`);
      expect(alerts.length).toBe(1);
      expect(alerts[0]!.detail).toMatchObject({ reason: 'partial', not_charged: 1 });
      await rig.app.engine.sweep();
      await rig.app.engine.sweep();
      const cases = await rig.rows<{ kind: string; state: string; order_id: string }>(
        'SELECT kind, state, order_id FROM recovery_cases',
      );
      expect(cases).toEqual([{ kind: 'partial_composite', state: 'open', order_id: run.order_id }]);
      expect(
        (await rig.app.engine.orderView({ order_ref: run.order_ref, actor: rig.A }))?.open_case
          ?.state,
      ).toBe('open');
      expect(await failing()).toEqual([]);
    },
  );
});

describe('D-03 no_substitution', () => {
  it('D-03 after the partial no order, quote, proposal or approval appears, and no further PayPal order is created, however many passes run', async () => {
    const run = await runPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET], ['happy', 'declined']);
    expect(await orderStatus(rig, run.order_id)).toBe('paid_partial');
    await rig.app.engine.sweep();
    const before = await fingerprint(rig);
    const createsBefore = rig.calls('create_order');
    const countsBefore = {
      orders: await rig.count('SELECT count(*) AS c FROM orders'),
      quotes: await rig.count('SELECT count(*) AS c FROM quotes'),
      proposals: await rig.count('SELECT count(*) AS c FROM proposals'),
      approvals: await rig.count('SELECT count(*) AS c FROM approvals'),
    };
    expect(countsBefore).toEqual({ orders: 1, quotes: 2, proposals: 1, approvals: 1 });

    // Time passes: the job loop runs its passes, the sweep runs again, the buyer opens pages.
    const jobs = await rig.app.startJobs();
    await new Promise((r) => setTimeout(r, 1500));
    await jobs.stop();
    await rig.app.engine.sweep();
    await rig.app.engine.orderView({ order_ref: run.order_ref, actor: rig.A });
    await libraryOf(rig, 'A');

    expect({
      orders: await rig.count('SELECT count(*) AS c FROM orders'),
      quotes: await rig.count('SELECT count(*) AS c FROM quotes'),
      proposals: await rig.count('SELECT count(*) AS c FROM proposals'),
      approvals: await rig.count('SELECT count(*) AS c FROM approvals'),
    }).toEqual(countsBefore);
    expect(rig.calls('create_order')).toBe(createsBefore);
    expect(rig.calls('capture_order')).toBe(2);
    // The books and the access did not move either (the whole fingerprint but the audit-free tables).
    const after = await fingerprint(rig);
    for (const t of [
      'orders',
      'order_units',
      'ledger_entries',
      'entitlements',
      'quotes',
      'proposals',
      'approvals',
    ] as const) {
      expect(after[t], t).toBe(before[t]);
    }
  });
});
