// PG-2: the loop body runs only while this process holds the leader lease. Payments is replaced by
// spies (as in loop.test.ts) and the election by a fake: no database here. The real-Postgres side is
// tests/mvp-c-pg.
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

const logs: { msg: string; level: string; fields: Record<string, unknown> }[] = [];
const zero = { processed: 0, still_unknown: 0, expired: 0, abandoned: 0 };

function makeDeps() {
  const clock = fakeClock('2026-10-22T10:00:00.000Z');
  const sweepWindows = vi.fn(() => Promise.resolve({ ended: 0 }));
  const log = {
    log: (e: { msg: string; level: string; fields: Record<string, unknown> }) => {
      logs.push(e);
    },
    child: () => log,
  };
  const ping = vi.fn(() => Promise.resolve({ kind: 'ok' }));
  const d = {
    db: { query: vi.fn(), exec: vi.fn(), transaction: vi.fn(), dialect: 'pg' },
    clock,
    ids: { next: () => 'x', nonce: () => 'n' },
    log,
    audit: { record: () => Promise.resolve() },
    switches: { isOn: () => Promise.resolve(true) },
    config: { abandoned_checkout_ms: 86_400_000 },
    environment: 'dryrun',
    paypal: { ping },
    content: {},
    sweepWindows,
  } as unknown as PaymentsDeps & { sweepWindows: typeof sweepWindows };
  return { d, sweepWindows, ping };
}

/** A lease the test can take away. */
function lease() {
  let held = true;
  let lose!: () => void;
  const lost = new Promise<void>((r) => {
    lose = () => {
      held = false;
      r();
    };
  });
  const release = vi.fn(() => {
    held = false;
    return Promise.resolve();
  });
  return { held: () => held, lost, release, lose };
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (f: () => boolean, tries = 600) => {
  for (let i = 0; !f(); i += 1) {
    if (i > tries) throw new Error('condition not reached');
    await pause(5);
  }
};
const opts = { max_sleep_ms: 10, max_items: 5, leader_retry_ms: 15 };

beforeEach(() => {
  logs.length = 0;
  vi.mocked(runDue).mockReset().mockResolvedValue(zero);
  vi.mocked(recoverOnStartup).mockReset().mockResolvedValue({ resumed: 0, repaired: 0 });
  vi.mocked(nextDueAt).mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PG-2 leader lease', () => {
  it('runs nothing while another process leads, and retries the election', async () => {
    const { d, sweepWindows } = makeDeps();
    const tryAcquire = vi.fn(() => Promise.resolve(null));
    const loop = startLoop(d, { ...opts, leader: { tryAcquire } });
    await until(() => tryAcquire.mock.calls.length >= 3);
    expect(runDue).not.toHaveBeenCalled();
    expect(sweepWindows).not.toHaveBeenCalled();
    expect(recoverOnStartup).not.toHaveBeenCalled();
    await loop.stop();
  });

  it('after the lease is won it recovers once, then runs passes', async () => {
    const { d, sweepWindows } = makeDeps();
    const l = lease();
    const answers = [null, null, l];
    const tryAcquire = vi.fn(() => Promise.resolve(answers.shift() ?? null));
    const order: string[] = [];
    vi.mocked(recoverOnStartup).mockImplementation(() => {
      order.push('recover');
      return Promise.resolve({ resumed: 0, repaired: 0 });
    });
    vi.mocked(runDue).mockImplementation(() => {
      order.push('pass');
      return Promise.resolve(zero);
    });
    const loop = startLoop(d, { ...opts, leader: { tryAcquire } });
    await until(() => order.filter((x) => x === 'pass').length >= 2);
    expect(order[0]).toBe('recover');
    expect(order.filter((x) => x === 'recover')).toHaveLength(1);
    expect(sweepWindows).toHaveBeenCalled();
    await loop.stop();
  });

  it('stop() releases the lease and awaits the release', async () => {
    const { d } = makeDeps();
    const l = lease();
    const loop = startLoop(d, { ...opts, leader: { tryAcquire: () => Promise.resolve(l) } });
    await until(() => vi.mocked(runDue).mock.calls.length >= 1);
    await loop.stop();
    expect(l.release).toHaveBeenCalledTimes(1);
    const after = vi.mocked(runDue).mock.calls.length;
    await pause(60);
    expect(vi.mocked(runDue).mock.calls.length).toBe(after);
  });

  it('a lost lease stops the passes at once, then the election runs again and passes resume', async () => {
    const { d } = makeDeps();
    const first = lease();
    const second = lease();
    let next: ReturnType<typeof lease> | null = first;
    const tryAcquire = vi.fn(() => {
      const give = next;
      next = null; // each lease is given out once; the test decides when the next one is available
      return Promise.resolve(give);
    });
    const loop = startLoop(d, { ...opts, leader: { tryAcquire } });
    await until(() => vi.mocked(runDue).mock.calls.length >= 2);
    first.lose();
    await pause(5); // the loop has noticed
    const frozen = vi.mocked(runDue).mock.calls.length;
    const asked = tryAcquire.mock.calls.length;
    await pause(60);
    // at most one pass that was already running when the lease went; no new pass until re-elected
    expect(vi.mocked(runDue).mock.calls.length - frozen).toBeLessThanOrEqual(1);
    expect(tryAcquire.mock.calls.length).toBeGreaterThan(asked); // it keeps asking
    next = second;
    const before = vi.mocked(runDue).mock.calls.length;
    await until(() => vi.mocked(runDue).mock.calls.length > before + 1);
    expect(recoverOnStartup).toHaveBeenCalledTimes(2); // once per leadership term
    await loop.stop();
    expect(second.release).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.msg === 'jobs.loop.leader_lost')).toBe(true);
  });

  it('a pass that is still running when the lease is lost cannot reach the provider any more', async () => {
    const { d, ping } = makeDeps();
    const l = lease();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: unknown[] = [];
    vi.mocked(runDue).mockImplementation(async (deps) => {
      seen.push(await (deps.paypal as unknown as { ping(): Promise<unknown> }).ping()); // led
      await gate;
      seen.push(await (deps.paypal as unknown as { ping(): Promise<unknown> }).ping()); // after loss
      return zero;
    });
    const loop = startLoop(d, {
      ...opts,
      leader: { tryAcquire: vi.fn().mockResolvedValueOnce(l).mockResolvedValue(null) },
    });
    await until(() => seen.length === 1);
    l.lose();
    await pause(5);
    release();
    await until(() => seen.length === 2);
    expect(seen[0]).toEqual({ kind: 'ok' });
    expect(seen[1]).toEqual({ kind: 'blocked', by: 'kill_switch' });
    expect(ping).toHaveBeenCalledTimes(1);
    await loop.stop();
  });

  it('a failing election is logged and retried, never run as if elected', async () => {
    const { d } = makeDeps();
    const tryAcquire = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(null);
    const loop = startLoop(d, { ...opts, leader: { tryAcquire } });
    await until(() => tryAcquire.mock.calls.length >= 3);
    expect(runDue).not.toHaveBeenCalled();
    expect(logs.some((l) => l.msg === 'jobs.loop.leader_election_failed')).toBe(true);
    await loop.stop();
  });

  it('stop() while waiting for the election returns promptly and holds nothing', async () => {
    const { d } = makeDeps();
    const loop = startLoop(d, {
      ...opts,
      leader_retry_ms: 60_000,
      leader: { tryAcquire: () => Promise.resolve(null) },
    });
    await pause(20);
    const outcome = await Promise.race([
      loop.stop().then(() => 'stopped'),
      pause(1_000).then(() => 'too slow'),
    ]);
    expect(outcome).toBe('stopped');
  });

  it('without a leader option nothing changes: recovery on start, then passes', async () => {
    const { d } = makeDeps();
    const loop = startLoop(d, { max_sleep_ms: 10, max_items: 5 });
    await until(() => vi.mocked(runDue).mock.calls.length >= 1);
    expect(recoverOnStartup).toHaveBeenCalledTimes(1);
    await loop.stop();
  });
});
