// Integration: approval to available item over the real adapter and the dry-run transport,
// fixtures only (synthetic, labelled; not PayPal evidence). The offline twin of journey B-08.
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createPayPalAdapter } from '@umsbx/paypal';
import { createDryRunTransport, loadFixtures } from '@umsbx/transport';
import { seededIds } from '@umsbx/runtime';
import type { Ids, PaymentsDeps } from '@umsbx/contracts';
import { applyReadback, beginCheckout, onBuyerReturn, placeOrder, readApplyGates } from './index';
import { BUYER_A, count, makeWorld } from './support';
import type { World } from './support';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/paypal/', import.meta.url));

// The synthetic fixtures use fixed identifiers: order reference ord_SBX0001, unit unit-1.
function fixtureIds(): Ids {
  const base = seededIds('integration');
  let ord = 0;
  return {
    nonce: () => base.nonce(),
    next: (prefix) => {
      if (prefix === 'ord') {
        ord += 1;
        return ord === 1 ? 'ord_INTERNAL1' : 'ord_SBX0001';
      }
      if (prefix === 'unt') return 'unit-1';
      return base.next(prefix);
    },
  };
}

let w: World;
afterEach(async () => {
  await w.close();
});

async function dryRunWorld(scenario: string) {
  w = await makeWorld({
    ids: fixtureIds(),
    price: 500,
    merchants: { pub_1: 'SBXMERCHANT01', pub_2: 'MERCH2' },
  });
  const transport = createDryRunTransport({
    fixtures: await loadFixtures(FIXTURE_ROOT),
    gate: { check: () => Promise.resolve({ allowed: true, approval_ref: 'test-approval' }) },
    clock: w.clock,
    default_scenario: scenario,
    log: {
      log: () => undefined,
      child: () => ({ log: () => undefined, child: () => undefined as never }),
    },
  });
  const adapter = createPayPalAdapter({
    transport,
    clock: w.clock,
    log: { log: () => undefined, child: () => undefined as never },
    credentials: null,
    record: () => Promise.resolve(),
  });
  const deps: PaymentsDeps = { ...w.deps, paypal: adapter };
  return { transport, deps };
}

describe('dry-run journeys over the real adapter', () => {
  it('B-08 offline twin: approval to available item with six provider calls at most', async () => {
    const { transport, deps } = await dryRunWorld('happy');
    const approval = await w.approval();
    const placed = await placeOrder(deps, {
      approval_id: approval.approval_id,
      token: approval.token,
      actor: BUYER_A,
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.value.order_ref).toBe('ord_SBX0001');
    const checkout = await beginCheckout(deps, {
      order_id: placed.value.order_id,
      actor: BUYER_A,
      scenario: 'happy',
    });
    expect(checkout).toEqual({
      ok: true,
      value: { approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=SBXHAPPYORD00001' },
    });
    const returned = await onBuyerReturn(deps, {
      order_ref: 'ord_SBX0001',
      actor: BUYER_A,
      scenario: 'happy',
    });
    expect(returned.ok).toBe(true);
    if (!returned.ok) return;
    expect(returned.value.status).toBe('paid');
    expect(returned.value.items[0]).toMatchObject({ article_id: 'art_1', access: 'available' });

    const calls = transport.calls();
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(calls.map((c) => c.operation)).toEqual([
      'create_order',
      'get_order',
      'capture_order',
      'get_order',
    ]);
    expect(calls.every((c) => c.outcome === 'response')).toBe(true);
    const capture = calls.find((c) => c.operation === 'capture_order')!;
    expect(capture.headers['PayPal-Request-Id'] ?? capture.headers['paypal-request-id']).toBe(
      'umsK-ord_SBX0001',
    );

    expect(await count(w, 'ledger_entries', "kind = 'sale' AND amount_minor = 500")).toBe(1);
    expect(await count(w, 'ledger_entries', "kind = 'paypal_fee' AND amount_minor = 45")).toBe(1);
    expect(await count(w, 'receipts')).toBe(1);
    const [u] = await w.rows<{ capture_id: string; status: string }>(
      'SELECT capture_id, status FROM order_units',
    );
    expect(u).toEqual({ capture_id: 'SBXHAPPYCAP00001', status: 'captured_verified' });
  });

  it('pending_receiving_pref: locked, the reason is shown, nothing booked', async () => {
    const { transport, deps } = await dryRunWorld('pending_receiving_pref');
    const approval = await w.approval();
    const placed = await placeOrder(deps, {
      approval_id: approval.approval_id,
      token: approval.token,
      actor: BUYER_A,
    });
    if (!placed.ok) throw new Error('place');
    await beginCheckout(deps, {
      order_id: placed.value.order_id,
      actor: BUYER_A,
      scenario: 'pending_receiving_pref',
    });
    const r = await onBuyerReturn(deps, {
      order_ref: 'ord_SBX0001',
      actor: BUYER_A,
      scenario: 'pending_receiving_pref',
    });
    expect(r.ok && r.value.status).toBe('unresolved');
    expect(r.ok && r.value.items[0]!.access).toBe('locked');
    expect(r.ok && r.value.buyer_message).toBe('Payment pending at PayPal');
    expect(r.ok && r.value.operator_note).toBe('RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION');
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(transport.calls().length).toBeLessThanOrEqual(6);
  });

  it('declined: not unlocked, order failed', async () => {
    const { deps } = await dryRunWorld('declined');
    const approval = await w.approval();
    const placed = await placeOrder(deps, {
      approval_id: approval.approval_id,
      token: approval.token,
      actor: BUYER_A,
    });
    if (!placed.ok) throw new Error('place');
    await beginCheckout(deps, {
      order_id: placed.value.order_id,
      actor: BUYER_A,
      scenario: 'declined',
    });
    const r = await onBuyerReturn(deps, {
      order_ref: 'ord_SBX0001',
      actor: BUYER_A,
      scenario: 'declined',
    });
    expect(r.ok && r.value.status).toBe('failed');
    expect(await count(w, 'ledger_entries')).toBe(0);
  });

  it('lost_capture_response: the answer is lost, one read-back finds the capture, still one capture call', async () => {
    const { transport, deps } = await dryRunWorld('lost_capture_response');
    const approval = await w.approval();
    const placed = await placeOrder(deps, {
      approval_id: approval.approval_id,
      token: approval.token,
      actor: BUYER_A,
    });
    if (!placed.ok) throw new Error('place');
    await beginCheckout(deps, {
      order_id: placed.value.order_id,
      actor: BUYER_A,
      scenario: 'lost_capture_response',
    });
    const r = await onBuyerReturn(deps, {
      order_ref: 'ord_SBX0001',
      actor: BUYER_A,
      scenario: 'lost_capture_response',
    });
    expect(r.ok && r.value.status).toBe('unresolved');
    expect(await count(w, 'ledger_entries')).toBe(0);

    // The reconciler's read (lane 05b does this): the order is COMPLETED at PayPal.
    const read = await deps.paypal.getOrder('SBXHAPPYORD00001', 'lost_capture_response');
    expect(read.kind).toBe('order');
    if (read.kind !== 'order') return;
    const gates = await readApplyGates(deps, placed.value.order_id);
    const report = await deps.db.transaction((tx) =>
      applyReadback(tx, deps, { order_id: placed.value.order_id, read, trigger: 'poll', gates }),
    );
    expect(report.order_status).toBe('paid');
    expect(report.unlocked).toHaveLength(1);
    expect(transport.calls().filter((c) => c.operation === 'capture_order')).toHaveLength(1);
  });
});
