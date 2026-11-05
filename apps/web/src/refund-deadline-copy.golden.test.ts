// BR-4 golden: the words a buyer reads about the refund deadline on the library item and the receipt
// (D-051: no day count in the copy; the date comes from the sale's frozen terms). Three states: the
// window is open ("Refunds can be requested until <date>"), it has ended ("Refund period ended"), and
// the sale has no deadline (approved before the terms were recorded): no line at all. The reviewed file
// is golden/refund-deadline-copy.golden.txt. A change to it is a change to what people are told.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { refundWindowLine, refundWindowView } from './lib/buyer-copy';

const DEADLINE = '2026-11-08T10:00:00.000Z';
const at = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();

describe('refundWindowView', () => {
  it('is open strictly before the deadline', () => {
    expect(refundWindowView(DEADLINE, at(DEADLINE, -1))).toEqual({
      state: 'open',
      deadline: DEADLINE,
    });
  });
  it('is ended at the deadline and after it', () => {
    expect(refundWindowView(DEADLINE, DEADLINE)).toEqual({ state: 'ended', deadline: DEADLINE });
    expect(refundWindowView(DEADLINE, at(DEADLINE, 1))).toEqual({
      state: 'ended',
      deadline: DEADLINE,
    });
  });
  it('is none when the sale has no deadline', () => {
    expect(refundWindowView(null, DEADLINE)).toEqual({ state: 'none' });
  });
});

describe('refund deadline copy (golden)', () => {
  it('matches golden/refund-deadline-copy.golden.txt', () => {
    const lines = [
      `open: ${refundWindowLine(refundWindowView(DEADLINE, at(DEADLINE, -86_400_000)))}`,
      `ended: ${refundWindowLine(refundWindowView(DEADLINE, DEADLINE))}`,
      `no deadline: ${refundWindowLine(refundWindowView(null, DEADLINE)) ?? '(no line)'}`,
    ];
    const expected = readFileSync(
      new URL('./golden/refund-deadline-copy.golden.txt', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines).toEqual(expected);
  });

  it('never names a number of days', () => {
    for (const days of [1, 3, 7, 21, 30]) {
      const start = '2026-11-01T10:00:00.000Z';
      const deadline = at(start, days * 86_400_000);
      const line = refundWindowLine(refundWindowView(deadline, start)) ?? '';
      expect(line).not.toMatch(/\bdays?\b/i);
      expect(line).not.toMatch(new RegExp(`\\b${days} `));
    }
  });
});
