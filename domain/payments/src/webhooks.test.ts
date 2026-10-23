// Unit tests of the pure rules of webhook intake (lane CO-2): which key of a verified event names
// the order, and whether a read-back that is already queued is left alone (ASM-60). No database,
// no clock, no network.
import { describe, expect, it } from 'vitest';
import { OrderStatusSchema } from '@umsbx/contracts';
import type { OrderStatus, ProviderEvent, ProviderEventType } from '@umsbx/contracts';
import { COALESCE_MS, idsAreValid, planReadback, targetsOf, wantsReadback } from './webhooks';

const NOW = '2026-10-22T10:00:00.000Z';
const plus = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString();

const event = (type: ProviderEventType, o: Partial<ProviderEvent> = {}): ProviderEvent => ({
  event_id: 'WH-EVT-1',
  transmission_id: 'tx-1',
  type,
  provider_order_id: null,
  capture_id: null,
  refund_id: null,
  occurred_at: NOW,
  ...o,
});

const CAPTURE_TYPES: ProviderEventType[] = [
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
];

describe('targetsOf: event type to the keys that name the order, in the order tried', () => {
  it.each(CAPTURE_TYPES)('%s is found by its capture id', (type) => {
    expect(targetsOf(event(type, { capture_id: 'CAP1' }))).toEqual([
      { by: 'capture_id', key: 'CAP1' },
    ]);
  });

  it.each(CAPTURE_TYPES)('%s without a capture id is found by the provider refund id', (type) => {
    expect(targetsOf(event(type, { refund_id: 'REF1' }))).toEqual([
      { by: 'refund_id', key: 'REF1' },
    ]);
  });

  it.each(CAPTURE_TYPES)(
    '%s falls back to the provider order id when the capture is not found (lost response)',
    (type) => {
      expect(targetsOf(event(type, { provider_order_id: 'ORD1' }))).toEqual([
        { by: 'provider_order_id', key: 'ORD1' },
      ]);
      expect(targetsOf(event(type, { capture_id: 'CAP1', provider_order_id: 'ORD1' }))).toEqual([
        { by: 'capture_id', key: 'CAP1' },
        { by: 'provider_order_id', key: 'ORD1' },
      ]);
    },
  );

  it.each(CAPTURE_TYPES)('%s with no id at all names nothing', (type) => {
    expect(targetsOf(event(type))).toEqual([]);
  });

  it('the capture id wins over the refund id (the up link names the capture)', () => {
    expect(
      targetsOf(event('PAYMENT.CAPTURE.REFUNDED', { capture_id: 'CAP1', refund_id: 'REF1' })),
    ).toEqual([{ by: 'capture_id', key: 'CAP1' }]);
    expect(
      targetsOf(
        event('PAYMENT.CAPTURE.REFUNDED', {
          capture_id: 'CAP1',
          refund_id: 'REF1',
          provider_order_id: 'ORD1',
        }),
      ),
    ).toEqual([
      { by: 'capture_id', key: 'CAP1' },
      { by: 'provider_order_id', key: 'ORD1' },
    ]);
  });

  it('an empty capture id is not a key, the refund id is used', () => {
    expect(
      targetsOf(event('PAYMENT.CAPTURE.REFUNDED', { capture_id: '', refund_id: 'REF1' })),
    ).toEqual([{ by: 'refund_id', key: 'REF1' }]);
    expect(targetsOf(event('PAYMENT.CAPTURE.COMPLETED', { capture_id: '' }))).toEqual([]);
  });

  it.each<ProviderEventType>(['CHECKOUT.ORDER.APPROVED', 'CHECKOUT.PAYMENT-APPROVAL.REVERSED'])(
    '%s is found by the provider order id, and by nothing else',
    (type) => {
      expect(
        targetsOf(
          event(type, { provider_order_id: 'ORD1', capture_id: 'CAP1', refund_id: 'REF1' }),
        ),
      ).toEqual([{ by: 'provider_order_id', key: 'ORD1' }]);
      expect(targetsOf(event(type, { capture_id: 'CAP1' }))).toEqual([]);
    },
  );

  it('OTHER names nothing, whatever ids it carries', () => {
    const ids = { provider_order_id: 'ORD1', capture_id: 'CAP1', refund_id: 'REF1' };
    expect(targetsOf(event('OTHER', ids))).toEqual([]);
  });
});

describe('idsAreValid: printable ASCII without space or pipe (as CO-1), 1 to 256 characters', () => {
  const ok = (o: Partial<ProviderEvent> = {}) => idsAreValid(event('PAYMENT.CAPTURE.COMPLETED', o));
  it('accepts ordinary ids and the 1 and 256 character limits', () => {
    expect(ok({ capture_id: 'CAP-1_x.y', refund_id: 'a-b', provider_order_id: 'ORD1' })).toBe(true);
    expect(
      ok({ event_id: 'x', transmission_id: 'y'.repeat(256), capture_id: 'z'.repeat(256) }),
    ).toBe(true);
    expect(ok()).toBe(true); // null ids are fine
  });
  it.each([
    ['space in an id (CO-1 refuses it too)', { capture_id: 'a b' }],
    ['space at the edge', { event_id: ' x' }],
    ['pipe (the verifier refuses it)', { transmission_id: 'a|b' }],
    ['empty event id', { event_id: '' }],
    ['empty transmission id', { transmission_id: '' }],
    ['empty capture id', { capture_id: '' }],
    ['257 characters', { event_id: 'x'.repeat(257) }],
    ['NUL', { event_id: 'a\u0000b' }],
    ['control character', { capture_id: 'a\nb' }],
    ['DEL', { refund_id: 'a\u007fb' }],
    ['non-ASCII letter', { provider_order_id: 'ORDé' }],
    ['lone surrogate', { capture_id: 'CAP\ud800' }],
    ['right-to-left override', { transmission_id: 'tx‮1' }],
    ['zero-width space', { event_id: 'e​1' }],
  ] satisfies [string, Partial<ProviderEvent>][])('refuses %s', (_name, o) => {
    expect(ok(o)).toBe(false);
  });
});

describe('planReadback: coalescing within 60 s (ASM-60)', () => {
  it('the window is 60 seconds', () => {
    expect(COALESCE_MS).toBe(60_000);
  });

  it('no read-back operation: create one', () => {
    expect(planReadback(null, NOW)).toBe('create');
  });

  it('unknown and due in 59 s: nothing changes', () => {
    expect(planReadback({ state: 'unknown', next_retry_at: plus(59_000) }, NOW)).toBe('keep');
  });

  it('unknown and due in exactly 60 s: nothing changes (within 60 s includes 60 s)', () => {
    expect(planReadback({ state: 'unknown', next_retry_at: plus(60_000) }, NOW)).toBe('keep');
  });

  it('unknown and due in 61 s: moved to now', () => {
    expect(planReadback({ state: 'unknown', next_retry_at: plus(61_000) }, NOW)).toBe('advance');
  });

  it('unknown and already overdue or due now: nothing changes', () => {
    expect(planReadback({ state: 'unknown', next_retry_at: NOW }, NOW)).toBe('keep');
    expect(planReadback({ state: 'unknown', next_retry_at: plus(-3_600_000) }, NOW)).toBe('keep');
  });

  it('unknown without a retry time: moved to now', () => {
    expect(planReadback({ state: 'unknown', next_retry_at: null }, NOW)).toBe('advance');
  });

  it('settled operations (confirmed, failed) are opened again', () => {
    expect(planReadback({ state: 'confirmed', next_retry_at: null }, NOW)).toBe('reopen');
    expect(planReadback({ state: 'failed', next_retry_at: null }, NOW)).toBe('reopen');
  });

  it('an operation in flight (prepared, sent) is left alone', () => {
    expect(planReadback({ state: 'sent', next_retry_at: null }, NOW)).toBe('keep');
    expect(planReadback({ state: 'prepared', next_retry_at: null }, NOW)).toBe('keep');
  });
});

describe('wantsReadback: which orders a webhook may wake (R2)', () => {
  // An order nobody has captured is owned by the buyer-return path and the abandonment sweep: a
  // webhook-started read-back there would poll for 24 h and end in a false payment_unresolved alert.
  const cases: [OrderStatus, boolean, boolean][] = [
    ['created', false, false],
    ['created', true, true],
    ['awaiting_buyer', false, false],
    ['awaiting_buyer', true, true],
    ['capture_requested', false, true],
    ['capture_claimed', false, true],
    ['unresolved', false, true],
    ['paid', false, true],
    ['paid_partial', false, true],
    ['failed', false, false],
    ['failed', true, false],
    ['abandoned', false, false],
    ['abandoned', true, false],
    ['frozen', false, false],
    ['frozen', true, false],
  ];
  it.each(cases)('%s, capture operation: %s -> %s', (status, hasCaptureOp, expected) => {
    expect(wantsReadback(status, hasCaptureOp)).toBe(expected);
  });
  it('covers every order status', () => {
    expect([...new Set(cases.map((c) => c[0]))].sort()).toEqual(
      [...OrderStatusSchema.options].sort(),
    );
  });
});
