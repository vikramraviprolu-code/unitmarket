// DP-2a (MVP-D): the pure rules of the composite route. deriveOrderStatus is the only thing that sets
// orders.status; its table is in docs/specs/mvp-d-overview.md section 3. expectedFor cuts the stored
// expected transaction down to the units of one PayPal order. Keys are built from a po_ref.
import { describe, expect, it } from 'vitest';
import { ExpectedTransactionSchema } from '@umsbx/contracts';
import type { ExpectedTransaction } from '@umsbx/contracts';
import { deriveOrderStatus, expectedFor, poRefFor } from './composite';
import type { PoFacts, ProviderOrderState } from './composite';
import { captureKeyNumber, readbackKeyFor, requestIdFor } from './keys';

/** A PayPal order in `state`; `sent` says its own capture operation has first_sent_at. */
const po = (state: ProviderOrderState, sent = false): PoFacts => ({
  state,
  capture_first_sent: sent,
  partial: false,
});
const status = (...pos: PoFacts[]) => deriveOrderStatus(pos).status;

describe('deriveOrderStatus: rule 1, every PayPal order is terminal', () => {
  it('all captured: paid, no mismatch, no partial alert', () => {
    expect(deriveOrderStatus([po('captured', true), po('captured', true)])).toEqual({
      status: 'paid',
      mismatch: false,
      not_charged: 0,
    });
  });
  it('a single captured PayPal order is paid', () => {
    expect(status(po('captured', true))).toBe('paid');
  });
  it('captured + declined: paid_partial, one PayPal order not charged (the partial alert)', () => {
    expect(deriveOrderStatus([po('captured', true), po('declined', true)])).toEqual({
      status: 'paid_partial',
      mismatch: false,
      not_charged: 1,
    });
  });
  it.each(['failed', 'abandoned'] as const)('captured + %s: paid_partial, not charged', (s) => {
    const r = deriveOrderStatus([po('captured', true), po(s)]);
    expect(r).toMatchObject({ status: 'paid_partial', not_charged: 1 });
  });
  it('captured + frozen: paid_partial with mismatch and NO partial alert (frozen is on hold)', () => {
    expect(deriveOrderStatus([po('captured', true), po('frozen', true)])).toEqual({
      status: 'paid_partial',
      mismatch: true,
      not_charged: 0,
    });
  });
  it('a captured PayPal order with units that did not all verify is paid_partial, not charged 0', () => {
    // D1 dormant: one PayPal order, two units, one of them declined.
    expect(
      deriveOrderStatus([{ state: 'captured', capture_first_sent: true, partial: true }]),
    ).toEqual({ status: 'paid_partial', mismatch: false, not_charged: 0 });
  });
  it('no captured: any frozen is frozen (with mismatch), whatever the others', () => {
    expect(deriveOrderStatus([po('frozen'), po('declined', true)])).toEqual({
      status: 'frozen',
      mismatch: true,
      not_charged: 1,
    });
    expect(status(po('frozen', true))).toBe('frozen');
  });
  it('no captured, no frozen: all abandoned is abandoned; anything else is failed', () => {
    expect(status(po('abandoned'), po('abandoned'))).toBe('abandoned');
    expect(status(po('abandoned'), po('declined', true))).toBe('failed');
    expect(status(po('failed'), po('failed'))).toBe('failed');
    expect(status(po('declined', true))).toBe('failed');
  });
});

describe('deriveOrderStatus: rule 2, a capture was sent and some PayPal order is not terminal', () => {
  it('captured + approved: capture_requested (M-C)', () => {
    expect(status(po('captured', true), po('approved'))).toBe('capture_requested');
  });
  it('captured + capture_requested, approved + capture_requested: capture_requested', () => {
    expect(status(po('captured', true), po('capture_requested', true))).toBe('capture_requested');
    expect(status(po('approved'), po('capture_requested', true))).toBe('capture_requested');
  });
  it('captured + unresolved: unresolved', () => {
    expect(status(po('captured', true), po('unresolved', true))).toBe('unresolved');
  });
  it('any unresolved beats capture_claimed; capture_claimed beats capture_requested', () => {
    expect(status(po('unresolved', true), po('capture_claimed', true))).toBe('unresolved');
    expect(status(po('capture_claimed', true), po('capture_requested', true))).toBe(
      'capture_claimed',
    );
    expect(status(po('captured', true), po('capture_claimed', true))).toBe('capture_claimed');
  });
  it('a frozen or declined PayPal order after its own send counts as sent (M-C)', () => {
    expect(status(po('frozen', true), po('approved'))).toBe('capture_requested');
    expect(status(po('declined', true), po('approved'))).toBe('capture_requested');
    expect(status(po('failed', true), po('approved'))).toBe('capture_requested');
  });
  it('mismatch is true whenever a PayPal order is frozen, also while the order is in flight', () => {
    expect(deriveOrderStatus([po('frozen', true), po('approved')])).toMatchObject({
      status: 'capture_requested',
      mismatch: true,
    });
  });
});

describe('deriveOrderStatus: rule 3, no capture sent', () => {
  it('a PayPal order frozen before any send (the pass) is frozen', () => {
    expect(status(po('frozen'), po('approved'))).toBe('frozen');
  });
  it('failed, then abandoned, then prepared (created), otherwise awaiting_buyer', () => {
    expect(status(po('failed'), po('awaiting_buyer'))).toBe('failed');
    expect(status(po('abandoned'), po('approved'))).toBe('abandoned');
    expect(status(po('prepared'), po('awaiting_buyer'))).toBe('created');
    expect(status(po('awaiting_buyer'), po('approved'))).toBe('awaiting_buyer');
    expect(status(po('approved'), po('approved'))).toBe('awaiting_buyer');
  });
  it('rule 3: declined (no send) beside approved is not awaiting_buyer', () => {
    // DP-2b: a declined PayPal order with no send of its own is treated like a failed one.
    expect(status(po('declined'), po('approved'))).toBe('failed');
    expect(status(po('approved'), po('declined'))).toBe('failed');
    expect(status(po('declined'), po('awaiting_buyer'))).toBe('failed');
    // ... while a decline AFTER a send still lets the pack finish (M-C, rule 2).
    expect(status(po('declined', true), po('approved'))).toBe('capture_requested');
  });
  it('a single PayPal order reopened after payer_action (approved, first_sent_at kept) goes back to awaiting_buyer', () => {
    expect(status(po('approved', true))).toBe('awaiting_buyer');
  });
  it('a pack with nothing captured and PO1 reopened: awaiting_buyer, never capture_requested', () => {
    expect(status(po('approved', true), po('approved'))).toBe('awaiting_buyer');
  });
  it('a fresh single order: prepared is created, awaiting_buyer is awaiting_buyer', () => {
    expect(status(po('prepared'))).toBe('created');
    expect(status(po('awaiting_buyer'))).toBe('awaiting_buyer');
  });
});

describe('deriveOrderStatus: the in-flight states imply a send', () => {
  it('capture_requested / capture_claimed / unresolved / captured count as sent even if the flag is missing', () => {
    // A row backfilled by 0011 has the state but may have no operation timestamp to read.
    expect(status(po('capture_requested'), po('approved'))).toBe('capture_requested');
    expect(status(po('captured'), po('approved'))).toBe('capture_requested');
  });
});

describe('expectedFor', () => {
  const expected: ExpectedTransaction = ExpectedTransactionSchema.parse({
    order_ref: 'ord_REF',
    buyer_id: 'buy_A',
    content_hash: 'a'.repeat(64),
    currency: 'USD',
    total_minor: 1200,
    units: [
      {
        reference_id: 'unt_1',
        publisher_id: 'pub_1',
        payee_merchant_id: 'MERCH1',
        amount_minor: 800,
      },
      {
        reference_id: 'unt_2',
        publisher_id: 'pub_2',
        payee_merchant_id: 'MERCH2',
        amount_minor: 400,
      },
    ],
    created_at: '2026-10-22T10:00:00.000Z',
    environment: 'dryrun',
  });
  it('keeps the units of one PayPal order and the total of just those', () => {
    const one = expectedFor(expected, ['unt_2']);
    expect(one.units.map((u) => u.reference_id)).toEqual(['unt_2']);
    expect(one.total_minor).toBe(400);
    expect(one.order_ref).toBe('ord_REF');
    expect(ExpectedTransactionSchema.safeParse(one).success).toBe(true);
  });
  it('the whole order (every unit) returns the stored expected transaction unchanged', () => {
    expect(expectedFor(expected, ['unt_2', 'unt_1'])).toEqual(expected);
  });
  it('refuses an unknown unit and an empty slice', () => {
    expect(() => expectedFor(expected, ['unt_9'])).toThrow();
    expect(() => expectedFor(expected, [])).toThrow();
  });
});

describe('references and keys on a po_ref', () => {
  it('po_ref: the order_ref for single, <order_ref>-p<position> for per_publisher', () => {
    expect(poRefFor('ord_REF', 1, 'single')).toBe('ord_REF');
    expect(poRefFor('ord_REF', 1, 'per_publisher')).toBe('ord_REF-p1');
    expect(poRefFor('ord_REF', 2, 'per_publisher')).toBe('ord_REF-p2');
  });
  it('key formats: umsC-<po_ref>, umsK-<po_ref>[-n], umsB-<po_ref>', () => {
    expect(requestIdFor('create', 'ord_REF-p2')).toBe('umsC-ord_REF-p2');
    expect(requestIdFor('capture', 'ord_REF-p2')).toBe('umsK-ord_REF-p2');
    expect(requestIdFor('capture', 'ord_REF-p2', 2)).toBe('umsK-ord_REF-p2-2');
    expect(readbackKeyFor('ord_REF-p2')).toBe('umsB-ord_REF-p2');
    // a single order keeps the keys it always had
    expect(requestIdFor('create', 'ord_REF')).toBe('umsC-ord_REF');
    expect(requestIdFor('capture', 'ord_REF')).toBe('umsK-ord_REF');
  });
  it('captureKeyNumber on a po_ref counts keys, not positions', () => {
    expect(captureKeyNumber('ord_REF-p2', 'umsK-ord_REF-p2')).toBe(1);
    expect(captureKeyNumber('ord_REF-p2', 'umsK-ord_REF-p2-2')).toBe(2);
    expect(captureKeyNumber('ord_REF-p2', 'umsK-ord_REF-p2-3')).toBe(3);
    // another PayPal order's key is not this one's: it falls back to 1
    expect(captureKeyNumber('ord_REF-p2', 'umsK-ord_REF-p1-2')).toBe(1);
  });
  it('the keys of two PayPal orders of one order never collide, for every attempt', () => {
    const seen = new Set<string>();
    for (const ref of ['ord_REF-p1', 'ord_REF-p2']) {
      for (const n of [1, 2, 3]) seen.add(requestIdFor('capture', ref, n));
      seen.add(requestIdFor('create', ref));
      seen.add(readbackKeyFor(ref));
    }
    expect(seen.size).toBe(2 * 5);
  });
});
