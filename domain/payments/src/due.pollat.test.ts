// BU-5b unit tests of nextPollAt past the end of the window.
import { describe, expect, it } from 'vitest';
import { nextPollAt } from './due';

const cfg = { reconcile_backoff_ms: [30_000, 120_000, 600_000, 3_600_000] };
const T0 = Date.parse('2026-10-22T10:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

describe('nextPollAt', () => {
  it('inside the window it is still capped at the window end (the last read happens there)', () => {
    // 2 h in, polls at 30 s, 2.5 s ... the next scheduled one is after 'until' = 1 h 5 min
    expect(nextPollAt(cfg, iso(0), iso(0), iso(65 * 60_000))).toBe(iso(30_000));
    expect(nextPollAt(cfg, iso(0), iso(15 * 60_000), iso(20 * 60_000))).toBe(iso(20 * 60_000));
  });
  it('past the window end it is one last backoff step from now, never the past `until`', () => {
    const now = iso(25 * 3_600_000);
    const until = iso(24 * 3_600_000);
    expect(nextPollAt(cfg, iso(0), now, until)).toBe(iso(26 * 3_600_000));
  });
  it('at the window end exactly, the same: one step ahead of now', () => {
    const now = iso(24 * 3_600_000);
    expect(nextPollAt(cfg, iso(0), now, now)).toBe(iso(25 * 3_600_000));
  });
  it('the step is the last entry of the configured backoff', () => {
    const now = iso(5 * 3_600_000);
    expect(nextPollAt({ reconcile_backoff_ms: [1000, 7000] }, iso(0), now, iso(3_600_000))).toBe(
      iso(5 * 3_600_000 + 7000),
    );
  });
  it('an empty or broken backoff still gives a future time (30 s)', () => {
    const now = iso(5 * 3_600_000);
    expect(nextPollAt({ reconcile_backoff_ms: [] }, iso(0), now, iso(0))).toBe(
      iso(5 * 3_600_000 + 30_000),
    );
    expect(nextPollAt({ reconcile_backoff_ms: [0] }, iso(0), now, iso(0))).toBe(
      iso(5 * 3_600_000 + 1),
    );
  });
  it('one millisecond before the window end it is capped at the end', () => {
    const until = iso(24 * 3_600_000);
    expect(nextPollAt(cfg, iso(0), iso(24 * 3_600_000 - 1), until)).toBe(until);
  });
});
