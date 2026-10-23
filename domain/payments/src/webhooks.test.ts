// Unit tests of the pure rules of webhook intake (lane CO-2): which key of a verified event names
// the order, and whether a read-back that is already queued is left alone (ASM-60). No database,
// no clock, no network.
import { describe, expect, it } from 'vitest';
import type { ProviderEvent, ProviderEventType } from '@umsbx/contracts';
import { COALESCE_MS, planReadback, targetOf } from './webhooks';

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

describe('targetOf: event type to the key that names the order', () => {
  it.each(CAPTURE_TYPES)('%s is found by its capture id', (type) => {
    expect(targetOf(event(type, { capture_id: 'CAP1' }))).toEqual({
      by: 'capture_id',
      key: 'CAP1',
    });
  });

  it.each(CAPTURE_TYPES)('%s without a capture id is found by the provider refund id', (type) => {
    expect(targetOf(event(type, { refund_id: 'REF1' }))).toEqual({
      by: 'refund_id',
      key: 'REF1',
    });
  });

  it.each(CAPTURE_TYPES)('%s with neither id names nothing', (type) => {
    expect(targetOf(event(type, { provider_order_id: 'ORD1' }))).toBeNull();
  });

  it('the capture id wins over the refund id (the up link names the capture)', () => {
    expect(
      targetOf(event('PAYMENT.CAPTURE.REFUNDED', { capture_id: 'CAP1', refund_id: 'REF1' })),
    ).toEqual({ by: 'capture_id', key: 'CAP1' });
  });

  it('an empty capture id is not a key, the refund id is used', () => {
    expect(
      targetOf(event('PAYMENT.CAPTURE.REFUNDED', { capture_id: '', refund_id: 'REF1' })),
    ).toEqual({ by: 'refund_id', key: 'REF1' });
    expect(targetOf(event('PAYMENT.CAPTURE.COMPLETED', { capture_id: '' }))).toBeNull();
  });

  it('CHECKOUT.ORDER.APPROVED is found by the provider order id, and by nothing else', () => {
    expect(
      targetOf(
        event('CHECKOUT.ORDER.APPROVED', {
          provider_order_id: 'ORD1',
          capture_id: 'CAP1',
          refund_id: 'REF1',
        }),
      ),
    ).toEqual({ by: 'provider_order_id', key: 'ORD1' });
    expect(targetOf(event('CHECKOUT.ORDER.APPROVED', { capture_id: 'CAP1' }))).toBeNull();
  });

  it('types that are not handled name nothing, whatever ids they carry', () => {
    const ids = { provider_order_id: 'ORD1', capture_id: 'CAP1', refund_id: 'REF1' };
    expect(targetOf(event('OTHER', ids))).toBeNull();
    expect(targetOf(event('CHECKOUT.PAYMENT-APPROVAL.REVERSED', ids))).toBeNull();
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
