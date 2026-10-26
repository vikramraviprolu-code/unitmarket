// BU-9 (hotfix): a pass that did nothing must not wake again after MIN_SLEEP_MS just because
// nextDueAt is overdue. The owner's sandbox run showed the loop re-reading a stale checkout about
// once a second (the call gap) for ever: the order could not be settled, so it stayed overdue, so the
// loop woke at once, every pass. Here payments is replaced by stand-ins and the clock and the timers
// move together, so ten minutes take no time; the real due work is tested in
// domain/payments/src/due.notfound.state.test.ts and tests/mvp-a/stale-not-found.integration.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentsDeps } from '@umsbx/contracts';
import { nextDueAt, recoverOnStartup, runDue } from '@umsbx/payments';
import { fakeClock } from '@umsbx/runtime';
import { startLoop } from './loop';

vi.mock('@umsbx/payments', () => ({
  runDue: vi.fn(),
  recoverOnStartup: vi.fn(),
  nextDueAt: vi.fn(),
}));

const START = '2026-10-26T10:00:00.000Z';
const MINUTE = 60_000;
const MAX_SLEEP = 5_000; // composition's production value
const zero = { processed: 0, still_unknown: 0, expired: 0, abandoned: 0 };
type Counts = typeof zero;

function world(environment: 'sandbox' | 'dryrun' = 'sandbox', max_calls_per_day = 300) {
  const clock = fakeClock(START);
  const t0 = clock.now().getTime();
  const reads: number[] = [];
  const passes: number[] = [];
  let used = 0;
  const paypal = {
    environment,
    // the stale order's PayPal order answers something that proves nothing (5xx / blocked)
    getOrder: () => {
      reads.push(clock.now().getTime() - t0);
      used += 1;
      return Promise.resolve({ kind: 'unavailable', retry_after_ms: null });
    },
  };
  const log = { log: () => undefined, child: () => log };
  const sweepWindows = vi.fn(() => Promise.resolve({ ended: 0 }));
  const d = {
    db: { query: vi.fn(), exec: vi.fn(), transaction: vi.fn(), dialect: 'pglite' },
    clock,
    ids: { next: () => 'x', nonce: () => 'n' },
    log,
    audit: { record: () => Promise.resolve() },
    switches: { isOn: () => Promise.resolve(true) },
    config: { abandoned_checkout_ms: 86_400_000 },
    environment,
    paypal,
    content: {},
    sweepWindows,
  } as unknown as PaymentsDeps & { sweepWindows: typeof sweepWindows };
  const callBudget = () =>
    Promise.resolve({ remaining_today: max_calls_per_day - used, max_calls_per_day });
  /** Moves the fake clock and the timers together, 100 ms at a time. */
  async function elapse(ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 100) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  const at = (ms: number): string => new Date(clock.now().getTime() + ms).toISOString();
  return { d, clock, t0, reads, passes, used: () => used, callBudget, elapse, at };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(runDue).mockReset().mockResolvedValue(zero);
  vi.mocked(recoverOnStartup).mockReset().mockResolvedValue({ resumed: 0, repaired: 0 });
  vi.mocked(nextDueAt).mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
});

/** The gaps between the passes, in ms of fake time. */
const gaps = (passes: number[]): number[] => passes.slice(1).map((t, i) => t - passes[i]!);

describe('(c) a stale order that cannot be read: the sleep after a zero pass is max_sleep_ms', () => {
  for (const environment of ['sandbox', 'dryrun'] as const) {
    it(`${environment}: overdue nextDueAt, passes that read once and settle nothing: every gap is max_sleep_ms, at most 121 reads in 10 minutes`, async () => {
      const x = world(environment);
      vi.mocked(nextDueAt).mockImplementation(() => Promise.resolve(x.at(-1000))); // overdue, always
      vi.mocked(runDue).mockImplementation(async (d) => {
        x.passes.push(x.clock.now().getTime() - x.t0);
        await d.paypal.getOrder('STALE');
        return zero;
      });
      const loop = startLoop(x.d, {
        max_sleep_ms: MAX_SLEEP,
        max_items: 100,
        recover_on_start: false,
        ...(environment === 'sandbox' ? { callBudget: x.callBudget } : {}),
        gap_sleep: (ms) => {
          x.clock.advance(ms);
          return Promise.resolve();
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      await x.elapse(10 * MINUTE);
      await loop.stop();
      expect(x.passes.length).toBeGreaterThan(100); // it kept going: slow, not stopped
      for (const g of gaps(x.passes)) expect(g).toBeGreaterThanOrEqual(MAX_SLEEP);
      expect(x.reads.length).toBeLessThanOrEqual((10 * MINUTE) / MAX_SLEEP + 1);
      expect(x.used()).toBe(x.reads.length);
    });
  }

  it('the allowance bounds the reads of a stale order that stays unreadable: never below the line, even in 10 minutes', async () => {
    const x = world('sandbox', 300);
    vi.mocked(nextDueAt).mockImplementation(() => Promise.resolve(x.at(-1000)));
    vi.mocked(runDue).mockImplementation(async (d, i) => {
      x.passes.push(x.clock.now().getTime() - x.t0);
      if (i.allow === 'money_only') return zero;
      await d.paypal.getOrder('STALE');
      return zero;
    });
    const loop = startLoop(x.d, {
      max_sleep_ms: 1_000,
      max_items: 100,
      recover_on_start: false,
      callBudget: x.callBudget,
      gap_sleep: (ms) => {
        x.clock.advance(ms);
        return Promise.resolve();
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await x.elapse(10 * MINUTE);
    await loop.stop();
    expect(x.reads.length).toBeLessThanOrEqual((10 * MINUTE) / 1_000 + 1);
    expect(300 - x.used()).toBeGreaterThanOrEqual(150); // the polling line of the default share
  });
});

describe('a zero pass is not a reason to hold back work that is due soon', () => {
  it('nothing done, next due time 1.2 s away: wakes at that time, not at max_sleep_ms', async () => {
    const x = world('dryrun');
    vi.mocked(nextDueAt).mockImplementation(() => Promise.resolve(x.at(1_200)));
    vi.mocked(runDue).mockImplementation(() => {
      x.passes.push(x.clock.now().getTime() - x.t0);
      return Promise.resolve(zero);
    });
    const loop = startLoop(x.d, {
      max_sleep_ms: MAX_SLEEP,
      max_items: 10,
      recover_on_start: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    await x.elapse(5_000);
    await loop.stop();
    expect(x.passes.slice(0, 3)).toEqual([0, 1_200, 2_400]);
  });

  it('nothing done, next due time already reached (wait 0): the slow rhythm, like an overdue one', async () => {
    const x = world('dryrun');
    vi.mocked(nextDueAt).mockImplementation(() => Promise.resolve(x.at(0)));
    vi.mocked(runDue).mockImplementation(() => {
      x.passes.push(x.clock.now().getTime() - x.t0);
      return Promise.resolve(zero);
    });
    const loop = startLoop(x.d, {
      max_sleep_ms: MAX_SLEEP,
      max_items: 10,
      recover_on_start: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    await x.elapse(12_000);
    await loop.stop();
    expect(x.passes.slice(0, 3)).toEqual([0, MAX_SLEEP, 2 * MAX_SLEEP]);
  });

  it('nothing done, next due time far away: capped at max_sleep_ms as before', async () => {
    const x = world('dryrun');
    vi.mocked(nextDueAt).mockImplementation(() => Promise.resolve(x.at(MINUTE)));
    vi.mocked(runDue).mockImplementation(() => {
      x.passes.push(x.clock.now().getTime() - x.t0);
      return Promise.resolve(zero);
    });
    const loop = startLoop(x.d, {
      max_sleep_ms: MAX_SLEEP,
      max_items: 10,
      recover_on_start: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    await x.elapse(12_000);
    await loop.stop();
    expect(x.passes.slice(0, 3)).toEqual([0, MAX_SLEEP, 2 * MAX_SLEEP]);
  });
});

describe('a pass that did something still comes back soon when more is overdue', () => {
  const progress: [string, Counts][] = [
    ['processed', { ...zero, processed: 1 }],
    ['abandoned', { ...zero, processed: 1, abandoned: 1 }],
    ['still_unknown', { ...zero, still_unknown: 1 }],
    ['expired', { ...zero, expired: 1 }],
  ];
  for (const [name, counts] of progress) {
    it(`${name}: overdue nextDueAt wakes the loop after MIN_SLEEP_MS (100 ms), as before`, async () => {
      const x = world('dryrun');
      vi.mocked(nextDueAt).mockImplementation(() => Promise.resolve(x.at(-1000)));
      vi.mocked(runDue).mockImplementation(() => {
        x.passes.push(x.clock.now().getTime() - x.t0);
        return Promise.resolve(counts);
      });
      const loop = startLoop(x.d, {
        max_sleep_ms: MAX_SLEEP,
        max_items: 10,
        recover_on_start: false,
      });
      await vi.advanceTimersByTimeAsync(0);
      await x.elapse(1_000);
      await loop.stop();
      expect(gaps(x.passes).slice(0, 5)).toEqual([100, 100, 100, 100, 100]);
    });
  }

  it('after a pass with progress followed by an idle one, the loop slows down; progress again, it speeds up', async () => {
    const x = world('dryrun');
    vi.mocked(nextDueAt).mockImplementation(() => Promise.resolve(x.at(-1000)));
    const script: Counts[] = [
      { ...zero, processed: 1 },
      zero,
      zero,
      { ...zero, processed: 1 },
      { ...zero, processed: 1 },
    ];
    vi.mocked(runDue).mockImplementation(() => {
      x.passes.push(x.clock.now().getTime() - x.t0);
      return Promise.resolve(script.shift() ?? zero);
    });
    const loop = startLoop(x.d, {
      max_sleep_ms: MAX_SLEEP,
      max_items: 10,
      recover_on_start: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    await x.elapse(30_000);
    await loop.stop();
    expect(gaps(x.passes).slice(0, 4)).toEqual([100, MAX_SLEEP, MAX_SLEEP, 100]);
  });
});
