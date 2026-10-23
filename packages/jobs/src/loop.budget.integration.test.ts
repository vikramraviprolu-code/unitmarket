// BU-5 integration test of the job loop with a call budget: the loop, the allowance and the call
// gap together. payments is replaced by a stand-in that spends calls on a counting port the way a
// pass of re-reads does (two calls per item: GET order, GET capture); the clock is a fake clock, the
// call gap advances it. The real due work is tested in domain/payments (due.budget.*.test.ts).
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

const START = '2026-10-22T10:00:00.000Z';
const HOUR = 3_600_000;
const logs: { msg: string; level: string; fields: Record<string, unknown> }[] = [];
const zero = { processed: 0, still_unknown: 0, expired: 0, abandoned: 0 };

type Snapshot = { remaining_today: number; max_calls_per_day: number } | null;

/** A port that counts every call against a daily budget and remembers when it was made. */
function world(config: Record<string, unknown> = {}, max_calls_per_day = 300) {
  const clock = fakeClock(START);
  const start = clock.now().getTime();
  const calls: number[] = [];
  let used = 0;
  const spend = (): Promise<string> => {
    calls.push(clock.now().getTime() - start);
    used += 1;
    return Promise.resolve('ok');
  };
  const paypal = {
    environment: 'sandbox' as const,
    getOrder: spend,
    getCapture: spend,
    captureOrder: spend,
  };
  const sweepWindows = vi.fn(() => Promise.resolve({ ended: 0 }));
  const log = {
    log: (e: { msg: string; level: string; fields: Record<string, unknown> }) => {
      logs.push(e);
    },
    child: () => log,
  };
  const d = {
    db: { query: vi.fn(), exec: vi.fn(), transaction: vi.fn(), dialect: 'pglite' },
    clock,
    ids: { next: () => 'x', nonce: () => 'n' },
    log,
    audit: { record: () => Promise.resolve() },
    switches: { isOn: () => Promise.resolve(true) },
    config: { abandoned_checkout_ms: 86_400_000, ...config },
    environment: 'sandbox',
    paypal,
    content: {},
    sweepWindows,
  } as unknown as PaymentsDeps & { sweepWindows: typeof sweepWindows };
  const budget = (): Promise<Snapshot> =>
    Promise.resolve({ remaining_today: max_calls_per_day - used, max_calls_per_day });
  return {
    d,
    clock,
    calls,
    sweepWindows,
    budget,
    used: () => used,
    remaining: () => max_calls_per_day - used,
    /** the gap sleeper of the loop: time passes on the fake clock */
    gap_sleep: (ms: number) => {
      clock.advance(ms);
      return Promise.resolve();
    },
  };
}

/** A pass of re-reads: items x (GET order + GET capture), as many items as it is allowed. */
function spendingPass(advance_ms = 0) {
  return vi.fn(async (d: PaymentsDeps, i: { max_items: number; allow?: string }) => {
    if (advance_ms > 0) (d.clock as unknown as { advance(ms: number): void }).advance(advance_ms);
    if (i.allow === 'money_only') return zero;
    for (let n = 0; n < i.max_items; n += 1) {
      await d.paypal.getOrder('ORDER');
      await d.paypal.getCapture('CAPTURE');
    }
    return { ...zero, processed: i.max_items };
  });
}

beforeEach(() => {
  logs.length = 0;
  vi.mocked(runDue).mockReset().mockResolvedValue(zero);
  vi.mocked(recoverOnStartup).mockReset().mockResolvedValue({ resumed: 0, repaired: 0 });
  vi.mocked(nextDueAt).mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
});

const passes = () => vi.mocked(runDue).mock.calls.length;

describe('call gap (PERF-9)', () => {
  it('never more than 2 calls in any 1 s window', async () => {
    const x = world({ min_call_gap_ms: 500 });
    vi.mocked(runDue).mockImplementation(spendingPass(1_000));
    const loop = startLoop(x.d, {
      max_sleep_ms: 1,
      max_items: 5,
      callBudget: x.budget,
      gap_sleep: x.gap_sleep,
    });
    await vi.waitFor(() => expect(passes()).toBeGreaterThanOrEqual(4));
    await loop.stop();
    expect(x.calls.length).toBeGreaterThanOrEqual(20);
    for (const t of x.calls) {
      const inWindow = x.calls.filter((c) => c >= t && c < t + 1000).length;
      expect(inWindow, `window starting at ${t}`).toBeLessThanOrEqual(2);
    }
  });

  it('the default gap is 500 ms when the config says nothing; a larger configured gap is kept', async () => {
    for (const [config, gap] of [
      [{}, 500],
      [{ min_call_gap_ms: 1500 }, 1500],
    ] as const) {
      logs.length = 0;
      vi.mocked(runDue).mockReset().mockImplementation(spendingPass(60_000));
      const x = world(config);
      const loop = startLoop(x.d, {
        max_sleep_ms: 1,
        max_items: 2,
        callBudget: x.budget,
        gap_sleep: x.gap_sleep,
      });
      await vi.waitFor(() => expect(passes()).toBeGreaterThanOrEqual(2));
      await loop.stop();
      const steps = x.calls.slice(1).map((t, i) => t - x.calls[i]!);
      const inPass = steps.filter((s) => s < 60_000);
      expect(inPass.length).toBeGreaterThan(0);
      expect(Math.min(...inPass)).toBe(gap);
    }
  });

  it('a gap of 0 in the config turns the gap off', async () => {
    const x = world({ min_call_gap_ms: 0 });
    vi.mocked(runDue).mockImplementation(spendingPass(60_000));
    const loop = startLoop(x.d, {
      max_sleep_ms: 1,
      max_items: 3,
      callBudget: x.budget,
      gap_sleep: x.gap_sleep,
    });
    await vi.waitFor(() => expect(passes()).toBeGreaterThanOrEqual(2));
    await loop.stop();
    expect(new Set(x.calls.slice(0, 6)).size).toBe(1); // one pass, no waiting between calls
  });
});

describe('the allowance decides each pass', () => {
  it('a buyer capture at hour 23 still finds at least capture_reserve_calls left', async () => {
    const x = world({ poll_budget_share: 0.5, capture_reserve_calls: 30 });
    // 10 minutes pass per loop pass; every pass would spend all of max_items if it were allowed
    vi.mocked(runDue).mockImplementation(spendingPass(600_000));
    const loop = startLoop(x.d, {
      max_sleep_ms: 1,
      max_items: 10,
      callBudget: x.budget,
      gap_sleep: x.gap_sleep,
    });
    const hour23 = Date.parse(START) + 23 * HOUR;
    await vi.waitFor(() => expect(x.clock.now().getTime()).toBeGreaterThanOrEqual(hour23), {
      timeout: 20_000,
    });
    await loop.stop();
    expect(x.remaining()).toBeGreaterThanOrEqual(30);
    // polling stopped at its share: it used at most half the day plus one pass of overshoot
    expect(x.used()).toBeLessThanOrEqual(150 + 2 * 10);
    expect(x.used()).toBeGreaterThan(100); // and it did poll until then
    // the buyer's capture at hour 23 goes through the same port
    await x.d.paypal.captureOrder({
      provider_order_id: 'P',
      request_id: 'R',
    });
    expect(x.remaining()).toBeGreaterThanOrEqual(29);
  });

  it('an allowance of n runs the pass with max_items n and allow all', async () => {
    const x = world();
    const loop = startLoop(x.d, {
      max_sleep_ms: 1,
      max_items: 100,
      callBudget: () => Promise.resolve({ remaining_today: 160, max_calls_per_day: 300 }),
    });
    await vi.waitFor(() => expect(passes()).toBeGreaterThanOrEqual(1));
    await loop.stop();
    expect(vi.mocked(runDue).mock.calls[0]![1]).toEqual({ max_items: 10, allow: 'all' });
  });

  it('an allowance above max_items is capped by max_items', async () => {
    const x = world();
    const loop = startLoop(x.d, { max_sleep_ms: 1, max_items: 7, callBudget: x.budget });
    await vi.waitFor(() => expect(passes()).toBeGreaterThanOrEqual(1));
    await loop.stop();
    expect(vi.mocked(runDue).mock.calls[0]![1]).toEqual({ max_items: 7, allow: 'all' });
  });

  it('an allowance of 0 still runs the pass, with money_only and the full max_items', async () => {
    const x = world();
    const loop = startLoop(x.d, {
      max_sleep_ms: 1,
      max_items: 7,
      callBudget: () => Promise.resolve({ remaining_today: 150, max_calls_per_day: 300 }),
    });
    await vi.waitFor(() => expect(passes()).toBeGreaterThanOrEqual(1));
    await loop.stop();
    expect(vi.mocked(runDue).mock.calls[0]![1]).toEqual({ max_items: 7, allow: 'money_only' });
    expect(x.sweepWindows).toHaveBeenCalled();
  });

  it('a null budget (dry run) is unlimited: the pass is the old pass, with the same deps', async () => {
    const x = world();
    const loop = startLoop(x.d, {
      max_sleep_ms: 1,
      max_items: 7,
      callBudget: () => Promise.resolve(null),
    });
    await vi.waitFor(() => expect(passes()).toBeGreaterThanOrEqual(1));
    await loop.stop();
    expect(vi.mocked(runDue).mock.calls[0]![0]).toBe(x.d); // no rate limiting either
    expect(vi.mocked(runDue).mock.calls[0]![1]).toEqual({ max_items: 7 });
  });

  it('with no callBudget option nothing changes: same deps, same arguments', async () => {
    const x = world();
    const loop = startLoop(x.d, { max_sleep_ms: 1, max_items: 7 });
    await vi.waitFor(() => expect(passes()).toBeGreaterThanOrEqual(1));
    await loop.stop();
    expect(vi.mocked(runDue).mock.calls[0]![0]).toBe(x.d);
    expect(vi.mocked(runDue).mock.calls[0]![1]).toEqual({ max_items: 7 });
  });

  it('configured share and reserve are used', async () => {
    const x = world({ poll_budget_share: 0.9, capture_reserve_calls: 60 });
    const loop = startLoop(x.d, {
      max_sleep_ms: 1,
      max_items: 100,
      // line = max(60, 0.1 * 300) = 60
      callBudget: () => Promise.resolve({ remaining_today: 100, max_calls_per_day: 300 }),
    });
    await vi.waitFor(() => expect(passes()).toBeGreaterThanOrEqual(1));
    await loop.stop();
    expect(vi.mocked(runDue).mock.calls[0]![1]).toEqual({ max_items: 40, allow: 'all' });
  });

  it('the budget is not asked while outbound is paused', async () => {
    const x = world();
    (x.d.switches as { isOn: unknown }).isOn = () => Promise.resolve(false);
    const callBudget = vi.fn(x.budget);
    const loop = startLoop(x.d, { max_sleep_ms: 1, max_items: 7, callBudget });
    await vi.waitFor(() => expect(x.sweepWindows.mock.calls.length).toBeGreaterThanOrEqual(2));
    await loop.stop();
    expect(callBudget).not.toHaveBeenCalled();
    expect(passes()).toBe(0);
  });
});

describe('a budget that cannot be trusted', () => {
  it('callBudget throws: no call in that pass', async () => {
    const x = world();
    let n = 0;
    const callBudget = vi.fn(() => {
      n += 1;
      return n <= 2 ? Promise.reject(new Error('db down')) : x.budget();
    });
    vi.mocked(runDue).mockImplementation(spendingPass(0));
    const loop = startLoop(x.d, { max_sleep_ms: 1, max_items: 3, callBudget });
    await vi.waitFor(() => expect(callBudget.mock.calls.length).toBeGreaterThanOrEqual(3));
    await loop.stop();
    // the first two passes made no due run and no provider call; the third did
    expect(passes()).toBeGreaterThanOrEqual(1);
    expect(logs.filter((l) => l.msg === 'jobs.loop.call_budget_failed')).toHaveLength(2);
    expect(logs.find((l) => l.msg === 'jobs.loop.call_budget_failed')!.fields).toEqual({
      error: 'db down',
    });
    const first = vi.mocked(runDue).mock.invocationCallOrder[0]!;
    expect(callBudget.mock.invocationCallOrder[2]!).toBeLessThan(first);
    expect(x.sweepWindows.mock.calls.length).toBeGreaterThanOrEqual(3); // local work goes on
  });

  it('callBudget throws forever: the loop keeps asking, never calls PayPal, and does not spin', async () => {
    vi.useFakeTimers();
    const x = world();
    const callBudget = vi.fn(() => Promise.reject(new Error('broken')));
    vi.mocked(nextDueAt).mockResolvedValue('2000-01-01T00:00:00.000Z'); // something is overdue
    const loop = startLoop(x.d, {
      max_sleep_ms: 30_000,
      max_items: 3,
      callBudget,
      recover_on_start: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(callBudget).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callBudget).toHaveBeenCalledTimes(1); // it waits max_sleep_ms, not 100 ms
    await vi.advanceTimersByTimeAsync(25_000);
    expect(callBudget).toHaveBeenCalledTimes(2);
    expect(passes()).toBe(0);
    expect(x.used()).toBe(0);
    await loop.stop();
  });

  it('callBudget returns negative or NaN: treated as 0 (money_only, never an all pass)', async () => {
    const bad: Snapshot[] = [
      { remaining_today: Number.NaN, max_calls_per_day: 300 },
      { remaining_today: -50, max_calls_per_day: 300 },
      { remaining_today: 200, max_calls_per_day: Number.NaN },
      { remaining_today: 200, max_calls_per_day: -300 },
      { remaining_today: Number.POSITIVE_INFINITY, max_calls_per_day: 300 },
      undefined as never,
      {} as never,
    ];
    for (const snapshot of bad) {
      vi.mocked(runDue).mockReset().mockResolvedValue(zero);
      const x = world();
      const loop = startLoop(x.d, {
        max_sleep_ms: 1,
        max_items: 4,
        callBudget: () => Promise.resolve(snapshot),
      });
      await vi.waitFor(() => expect(passes()).toBeGreaterThanOrEqual(1));
      await loop.stop();
      expect(vi.mocked(runDue).mock.calls[0]![1], JSON.stringify(snapshot)).toEqual({
        max_items: 4,
        allow: 'money_only',
      });
    }
  });
});

describe('a spent allowance does not make the loop spin', () => {
  it('with allowance 0 the loop waits at least a second even when work is overdue', async () => {
    vi.useFakeTimers();
    const x = world();
    vi.mocked(nextDueAt).mockResolvedValue('2000-01-01T00:00:00.000Z');
    const loop = startLoop(x.d, {
      max_sleep_ms: 30_000,
      max_items: 3,
      recover_on_start: false,
      callBudget: () => Promise.resolve({ remaining_today: 100, max_calls_per_day: 300 }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(passes()).toBe(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(passes()).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(passes()).toBe(2);
    await loop.stop();
  });

  it('with an allowance the old rhythm stays: overdue work wakes the loop after 100 ms', async () => {
    vi.useFakeTimers();
    const x = world();
    vi.mocked(nextDueAt).mockResolvedValue('2000-01-01T00:00:00.000Z');
    const loop = startLoop(x.d, {
      max_sleep_ms: 30_000,
      max_items: 3,
      recover_on_start: false,
      callBudget: () => Promise.resolve({ remaining_today: 300, max_calls_per_day: 300 }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(350);
    expect(passes()).toBeGreaterThanOrEqual(3);
    await loop.stop();
  });
});
