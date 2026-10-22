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
  vi.mocked(recoverOnStartup).mockReset().mockResolvedValue({ resumed: 0 });
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
      return Promise.resolve({ resumed: 2 });
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

  it('waits until the next due time but never longer than max_sleep_ms', async () => {
    vi.useFakeTimers();
    const { d, clock } = makeDeps();
    const sleeps: number[] = [];
    const realSet = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      sleeps.push(ms ?? 0);
      return realSet(fn, ms);
    }) as typeof setTimeout);
    vi.mocked(nextDueAt).mockImplementation(() =>
      Promise.resolve(new Date(clock.now().getTime() + 12_000).toISOString()),
    );
    const loop = startLoop(d, { max_sleep_ms: 30_000, max_items: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sleeps).toContain(12_000);
    vi.mocked(nextDueAt).mockImplementation(() =>
      Promise.resolve(new Date(clock.now().getTime() + 900_000).toISOString()),
    );
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sleeps).toContain(30_000);
    vi.mocked(nextDueAt).mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sleeps.filter((s) => s === 30_000).length).toBeGreaterThanOrEqual(2);
    await loop.stop();
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
    const t0 = process.hrtime.bigint();
    await loop.stop();
    expect(Number((process.hrtime.bigint() - t0) / 1_000_000n)).toBeLessThan(2000);
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
    d.db.query.mockResolvedValue({ rows: [{ n: 0 }] });
    clock.advance(1000);
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 5 });
    await vi.waitFor(() => expect(vi.mocked(runDue)).toHaveBeenCalled());
    await loop.stop();
    expect((await health(d)).last_pass_at).toBe('2026-10-22T10:00:01.000Z');
  });
});
