// Unit tests of the job loop (lane 05b): payments is replaced by spies, the clock is a fake clock,
// waiting uses real or fake timers. The loop is the only caller of recovery and runDue.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentsDeps, SwitchName } from '@umsbx/contracts';
import { nextDueAt, recoverOnStartup, runDue } from '@umsbx/payments';
import { fakeClock } from '@umsbx/runtime';
import { startLoop } from './loop';

vi.mock('@umsbx/payments', () => ({
  runDue: vi.fn(),
  recoverOnStartup: vi.fn(),
  nextDueAt: vi.fn(),
}));

const START = '2026-10-22T10:00:00.000Z';
const logs: { msg: string; level: string; fields: Record<string, unknown> }[] = [];

function makeDeps(switches: Partial<Record<SwitchName, boolean>> = {}) {
  const clock = fakeClock(START);
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
    switches: { isOn: (n: SwitchName) => Promise.resolve(switches[n] ?? true) },
    config: { abandoned_checkout_ms: 86_400_000 },
    environment: 'dryrun',
    paypal: {},
    content: {},
    sweepWindows,
  } as unknown as PaymentsDeps & { sweepWindows: typeof sweepWindows };
  return { d, clock, sweepWindows };
}
const zero = { processed: 0, still_unknown: 0, expired: 0, abandoned: 0 };

beforeEach(() => {
  logs.length = 0;
  vi.mocked(runDue).mockReset().mockResolvedValue(zero);
  vi.mocked(recoverOnStartup).mockReset().mockResolvedValue({ resumed: 0, repaired: 0 });
  vi.mocked(nextDueAt).mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('startLoop', () => {
  it('recovers first, then runs passes with the item budget, sweeping windows each time', async () => {
    const { d, sweepWindows } = makeDeps();
    const order: string[] = [];
    vi.mocked(recoverOnStartup).mockImplementation(() => {
      order.push('recover');
      return Promise.resolve({ resumed: 2, repaired: 0 });
    });
    vi.mocked(runDue).mockImplementation(() => {
      order.push('due');
      return Promise.resolve(zero);
    });
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7 });
    await vi.waitFor(() => expect(vi.mocked(runDue).mock.calls.length).toBeGreaterThanOrEqual(3));
    await loop.stop();
    expect(order[0]).toBe('recover');
    expect(order.slice(1, 3)).toEqual(['due', 'due']);
    expect(vi.mocked(recoverOnStartup)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runDue)).toHaveBeenCalledWith(d, { max_items: 7 });
    expect(sweepWindows).toHaveBeenCalledWith({ max_items: 7 });
  });

  it('does not recover again when the caller has already recovered (once per process)', async () => {
    const { d } = makeDeps();
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7, recover_on_start: false });
    await vi.waitFor(() => expect(vi.mocked(runDue).mock.calls.length).toBeGreaterThanOrEqual(2));
    await loop.stop();
    expect(vi.mocked(recoverOnStartup)).not.toHaveBeenCalled();
  });

  it('waits until the next due time', async () => {
    vi.useFakeTimers();
    const { d, clock } = makeDeps();
    const passes = (): number => vi.mocked(runDue).mock.calls.length;
    vi.mocked(nextDueAt).mockImplementation(() =>
      Promise.resolve(new Date(clock.now().getTime() + 12_000).toISOString()),
    );
    const loop = startLoop(d, { max_sleep_ms: 30_000, max_items: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(passes()).toBe(1);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(passes()).toBe(1); // still asleep
    await vi.advanceTimersByTimeAsync(1);
    expect(passes()).toBe(2); // woke at the due time, not later
    await loop.stop();
  });

  it('never sleeps longer than max_sleep_ms, and with nothing due sleeps exactly that long', async () => {
    vi.useFakeTimers();
    const { d, clock } = makeDeps();
    const passes = (): number => vi.mocked(runDue).mock.calls.length;
    vi.mocked(nextDueAt).mockImplementation(() =>
      Promise.resolve(new Date(clock.now().getTime() + 900_000).toISOString()),
    );
    const far = startLoop(d, { max_sleep_ms: 30_000, max_items: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(passes()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(passes()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(passes()).toBe(2);
    await far.stop();

    vi.mocked(runDue).mockClear();
    vi.mocked(nextDueAt).mockResolvedValue(null);
    const idle = startLoop(d, { max_sleep_ms: 20_000, max_items: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(passes()).toBe(1);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(passes()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(passes()).toBe(2);
    await idle.stop();
  });

  it('something already due runs again at once (a short floor, no spinning)', async () => {
    vi.useFakeTimers();
    const { d, clock } = makeDeps();
    vi.mocked(nextDueAt).mockImplementation(() =>
      Promise.resolve(new Date(clock.now().getTime() - 5000).toISOString()),
    );
    const loop = startLoop(d, { max_sleep_ms: 30_000, max_items: 10 });
    await vi.advanceTimersByTimeAsync(1000);
    const n = vi.mocked(runDue).mock.calls.length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThan(40);
    await loop.stop();
  });

  it('stop waits for the pass in progress, and no pass starts after it', async () => {
    const { d } = makeDeps();
    let release: () => void = () => undefined;
    let started = 0;
    vi.mocked(runDue).mockImplementation(async () => {
      started += 1;
      await new Promise<void>((r) => {
        release = r;
      });
      return zero;
    });
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 5 });
    await vi.waitFor(() => expect(started).toBe(1));
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).toBe(false); // the pass is still running
    release();
    await stopping;
    expect(stopped).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toBe(1);
  });

  it('stop while sleeping returns quickly', async () => {
    const { d } = makeDeps();
    const loop = startLoop(d, { max_sleep_ms: 600_000, max_items: 5 });
    await vi.waitFor(() => expect(vi.mocked(runDue)).toHaveBeenCalledTimes(1));
    // The sleep is 10 minutes long; stop must not wait for it.
    await Promise.race([
      loop.stop(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('stop waited for the sleep')), 2000);
      }),
    ]);
    await loop.stop(); // idempotent
  });

  it('a failing pass is logged and the loop carries on', async () => {
    const { d } = makeDeps();
    vi.mocked(runDue)
      .mockRejectedValueOnce(new Error('database restarted'))
      .mockResolvedValue(zero);
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 5 });
    await vi.waitFor(() => expect(vi.mocked(runDue).mock.calls.length).toBeGreaterThanOrEqual(2));
    await loop.stop();
    const err = logs.find((l) => l.level === 'error');
    expect(err).toBeDefined();
    expect(JSON.stringify(err)).toContain('database restarted');
  });

  it('a failing recovery is logged and the passes still run', async () => {
    const { d } = makeDeps();
    vi.mocked(recoverOnStartup).mockRejectedValue(new Error('no database yet'));
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 5 });
    await vi.waitFor(() => expect(vi.mocked(runDue)).toHaveBeenCalled());
    await loop.stop();
    expect(logs.some((l) => l.level === 'error')).toBe(true);
  });

  it('paused: with the outbound switch off no PayPal work runs, windows are still swept, and it says so', async () => {
    const { d, sweepWindows } = makeDeps({ paypal_outbound: false });
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 5 });
    await vi.waitFor(() => expect(sweepWindows.mock.calls.length).toBeGreaterThanOrEqual(2));
    await loop.stop();
    expect(vi.mocked(runDue)).not.toHaveBeenCalled();
    expect(vi.mocked(recoverOnStartup)).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.msg.includes('paused'))).toBe(true);
  });

  it('records the time of the last pass for health', async () => {
    const { d, clock } = makeDeps();
    const { health } = await import('./health');
    expect((await health(d)).last_pass_at).toBeNull();
    (d.db.query as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ n: 0 }] });
    clock.advance(1000);
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 5 });
    await vi.waitFor(() => expect(vi.mocked(runDue)).toHaveBeenCalled());
    await loop.stop();
    expect((await health(d)).last_pass_at).toBe('2026-10-22T10:00:01.000Z');
  });
});

describe('startLoop pause and resume (B-L5)', () => {
  it('the outbound switch off then on: no PayPal work while off, work resumes after, nothing else changes', async () => {
    const switches: Partial<Record<SwitchName, boolean>> = { paypal_outbound: true };
    const { d, sweepWindows } = makeDeps(switches);
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 4 });
    await vi.waitFor(() => expect(vi.mocked(runDue).mock.calls.length).toBeGreaterThanOrEqual(2));
    switches.paypal_outbound = false;
    // Let a pass that was already running finish, then count from a quiet point.
    await vi.waitFor(() => expect(logs.some((l) => l.msg.includes('paused'))).toBe(true));
    const frozen = vi.mocked(runDue).mock.calls.length;
    const swept = sweepWindows.mock.calls.length;
    await vi.waitFor(() => expect(sweepWindows.mock.calls.length).toBeGreaterThan(swept + 1));
    expect(vi.mocked(runDue).mock.calls.length).toBe(frozen);
    switches.paypal_outbound = true;
    await vi.waitFor(() => expect(vi.mocked(runDue).mock.calls.length).toBeGreaterThan(frozen));
    await loop.stop();
    expect(vi.mocked(runDue)).toHaveBeenLastCalledWith(d, { max_items: 4 });
    expect(vi.mocked(recoverOnStartup)).toHaveBeenCalledTimes(1);
  });

  it('a paused loop does not ask when work is next due (it sleeps the full max_sleep_ms)', async () => {
    const { d } = makeDeps({ paypal_outbound: false });
    vi.mocked(nextDueAt).mockResolvedValue('2000-01-01T00:00:00.000Z');
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 4 });
    await vi.waitFor(() => expect(logs.some((l) => l.msg.includes('paused'))).toBe(true));
    await loop.stop();
    expect(vi.mocked(nextDueAt)).not.toHaveBeenCalled();
  });

  it('stop while paused returns quickly and starts no further pass', async () => {
    const { d, sweepWindows } = makeDeps({ paypal_outbound: false });
    const loop = startLoop(d, { max_sleep_ms: 60_000, max_items: 4 });
    await vi.waitFor(() => expect(sweepWindows).toHaveBeenCalled());
    const settled = await Promise.race([
      loop.stop().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('too slow'), 1000)),
    ]);
    expect(settled).toBe('stopped');
    const n = sweepWindows.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(sweepWindows.mock.calls.length).toBe(n);
  });

  it('a switch that cannot be read counts as off: the loop pauses and carries on', async () => {
    const { d, sweepWindows } = makeDeps();
    (d.switches as { isOn: () => Promise<boolean> }).isOn = () =>
      Promise.reject(new Error('db down'));
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 4 });
    await vi.waitFor(() => expect(logs.some((l) => l.msg === 'jobs.loop.pass_failed')).toBe(true));
    await loop.stop();
    expect(vi.mocked(runDue)).not.toHaveBeenCalled();
    expect(sweepWindows).not.toHaveBeenCalled();
  });
});
