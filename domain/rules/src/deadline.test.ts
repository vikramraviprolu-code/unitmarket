// BR-4: the refund deadline is a pure function of the frozen terms and two timestamps. These tests
// pin the boundary (the window is open strictly before the deadline), the start (access start first,
// capture time as the fallback), version 1 (no deadline) and the reader of a stored snapshot (a
// version 2 snapshot without usable terms is never read as "no deadline").
import { describe, expect, it } from 'vitest';
import type { ResolvedTerms } from '@umsbx/contracts';
import { termsDigest } from './digest';
import { readSnapshotTerms, refundDeadline, refundWindowOpen } from './index';

const DAY = 86_400_000;
const START = '2026-11-01T10:00:00.000Z';
const CAPTURE = '2026-10-31T09:30:00.000Z';
const plus = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();

function termsOf(refundDays: number, accessDays = Math.max(refundDays, 1)): ResolvedTerms {
  const values = {
    'refund.request_window': refundDays,
    'access.window': accessDays,
    'mandate.max_days': 90,
  };
  return {
    rules_version: '1',
    values,
    sources: {
      'refund.request_window': 'default',
      'access.window': 'default',
      'mandate.max_days': 'default',
    },
    digest: termsDigest(values),
  };
}

describe('refundDeadline', () => {
  it('counts the refund window from the start of access', () => {
    expect(
      refundDeadline({
        terms: termsOf(7),
        access_started_at: START,
        captured_verified_at: CAPTURE,
      }),
    ).toBe(plus(START, 7 * DAY));
  });

  it('falls back to the verified capture time when access has not started', () => {
    expect(
      refundDeadline({
        terms: termsOf(7),
        access_started_at: null,
        captured_verified_at: CAPTURE,
      }),
    ).toBe(plus(CAPTURE, 7 * DAY));
  });

  it('prefers the access start over the capture time even when the capture is later', () => {
    const lateCapture = '2026-11-20T00:00:00.000Z';
    expect(
      refundDeadline({
        terms: termsOf(3),
        access_started_at: START,
        captured_verified_at: lateCapture,
      }),
    ).toBe(plus(START, 3 * DAY));
  });

  it('follows the frozen value: 0, 1, 21 and 30 days', () => {
    for (const days of [0, 1, 21, 30]) {
      expect(
        refundDeadline({
          terms: termsOf(days, 30),
          access_started_at: START,
          captured_verified_at: CAPTURE,
        }),
      ).toBe(plus(START, days * DAY));
    }
  });

  it('has no deadline for a version 1 sale (no terms)', () => {
    expect(
      refundDeadline({ terms: null, access_started_at: START, captured_verified_at: CAPTURE }),
    ).toBeNull();
  });

  it('reads the refund key, not the access key', () => {
    expect(
      refundDeadline({
        terms: termsOf(2, 9),
        access_started_at: START,
        captured_verified_at: CAPTURE,
      }),
    ).toBe(plus(START, 2 * DAY));
  });
});

describe('refundWindowOpen', () => {
  const deadline = plus(START, 7 * DAY);
  it('is open one millisecond before the deadline', () => {
    expect(refundWindowOpen(deadline, plus(deadline, -1))).toBe(true);
  });
  it('is closed at exactly the deadline', () => {
    expect(refundWindowOpen(deadline, deadline)).toBe(false);
  });
  it('is closed one millisecond after the deadline', () => {
    expect(refundWindowOpen(deadline, plus(deadline, 1))).toBe(false);
  });
  it('is open long before the deadline', () => {
    expect(refundWindowOpen(deadline, START)).toBe(true);
  });
  it('is always open with no deadline (version 1)', () => {
    expect(refundWindowOpen(null, '2099-01-01T00:00:00.000Z')).toBe(true);
  });
});

describe('readSnapshotTerms', () => {
  const t = termsOf(7);
  it('reads version 1 as having no terms', () => {
    expect(readSnapshotTerms({ snapshot_version: '1', items: [] })).toEqual({ kind: 'v1' });
  });
  it('reads a version 2 snapshot with valid terms', () => {
    expect(readSnapshotTerms({ snapshot_version: '2', items: [], terms: t })).toEqual({
      kind: 'v2',
      terms: t,
    });
  });
  it('reads a JSON string the way the database may return jsonb', () => {
    expect(readSnapshotTerms(JSON.stringify({ snapshot_version: '2', terms: t }))).toEqual({
      kind: 'v2',
      terms: t,
    });
  });
  it('refuses a version 2 snapshot with no terms', () => {
    expect(readSnapshotTerms({ snapshot_version: '2', items: [] })).toEqual({ kind: 'invalid' });
  });
  it('refuses a version 2 snapshot whose terms have a value outside the safe range', () => {
    const bad = { ...t, values: { ...t.values, 'refund.request_window': 31 } };
    expect(readSnapshotTerms({ snapshot_version: '2', terms: bad })).toEqual({ kind: 'invalid' });
    const neg = { ...t, values: { ...t.values, 'refund.request_window': -1 } };
    expect(readSnapshotTerms({ snapshot_version: '2', terms: neg })).toEqual({ kind: 'invalid' });
  });
  it('refuses terms where access is shorter than the refund window', () => {
    const bad = termsOf(7, 3);
    expect(readSnapshotTerms({ snapshot_version: '2', terms: bad })).toEqual({ kind: 'invalid' });
  });
  it('refuses a version 1 snapshot that carries a terms key', () => {
    expect(readSnapshotTerms({ snapshot_version: '1', terms: t })).toEqual({ kind: 'invalid' });
  });
  it('refuses an unknown version, a missing version, null, text that is not JSON and a non-object', () => {
    expect(readSnapshotTerms({ snapshot_version: '3', terms: t })).toEqual({ kind: 'invalid' });
    expect(readSnapshotTerms({ terms: t })).toEqual({ kind: 'invalid' });
    expect(readSnapshotTerms(null)).toEqual({ kind: 'invalid' });
    expect(readSnapshotTerms('not json')).toEqual({ kind: 'invalid' });
    expect(readSnapshotTerms(7)).toEqual({ kind: 'invalid' });
    expect(readSnapshotTerms([])).toEqual({ kind: 'invalid' });
  });
});
