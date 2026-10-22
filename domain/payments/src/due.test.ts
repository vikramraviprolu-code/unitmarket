// Unit tests: the poll schedule of the reconciler (backoff 30 s, 2 min, 10 min, 1 h, 1 h ...).
import { describe, expect, it } from 'vitest';
import { nextPollAt } from './due';

const CONFIG = { reconcile_backoff_ms: [30_000, 120_000, 600_000, 3_600_000] } as const;
const A = '2026-10-22T10:00:00.000Z';
const at = (ms: number): string => new Date(Date.parse(A) + ms).toISOString();
const UNTIL = at(86_400_000);

describe('nextPollAt', () => {
  it('backoff 30 s, 2 min, 10 min, 1 h, 1 h: the gaps between successive polls', () => {
    let now = A;
    const gaps: number[] = [];
    for (let k = 0; k < 6; k += 1) {
      const next = nextPollAt(CONFIG, A, now, UNTIL);
      gaps.push(Date.parse(next) - Date.parse(now));
      now = next;
    }
    expect(gaps).toEqual([30_000, 120_000, 600_000, 3_600_000, 3_600_000, 3_600_000]);
  });
  it('a late run does not stack delays: the next poll is the first scheduled time after now', () => {
    expect(nextPollAt(CONFIG, A, at(100_000), UNTIL)).toBe(at(150_000));
    expect(nextPollAt(CONFIG, A, at(150_000), UNTIL)).toBe(at(750_000));
    expect(nextPollAt(CONFIG, A, at(10_000_000), UNTIL)).toBe(at(11_550_000));
  });
  it('never later than the end of the window', () => {
    const until = at(200_000);
    expect(nextPollAt(CONFIG, A, at(150_000), until)).toBe(until);
    expect(nextPollAt(CONFIG, A, at(250_000), until)).toBe(until);
  });
  it('a single-entry backoff repeats', () => {
    expect(nextPollAt({ reconcile_backoff_ms: [1000] }, A, at(2500), UNTIL)).toBe(at(3000));
  });
  it('a zero entry still moves forward', () => {
    const next = nextPollAt({ reconcile_backoff_ms: [0] }, A, at(5), UNTIL);
    expect(Date.parse(next)).toBeGreaterThan(Date.parse(at(5)));
  });
});
