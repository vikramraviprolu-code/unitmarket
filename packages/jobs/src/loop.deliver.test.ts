// API-C (E2): the optional `deliver` hook of the job loop. Each pass calls it once, after the access
// windows are swept, in its own try/catch: a delivery that throws is logged as jobs.loop.deliver_failed
// and neither stops the loop nor counts as a failed pass. It runs while the outbound PayPal switch is
// off, because webhooks go to subscribers, not to PayPal. Without the option the loop is unchanged.
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

const logs: { msg: string; level: string; fields: Record<string, unknown> }[] = [];

function makeDeps(switches: Partial<Record<SwitchName, boolean>> = {}) {
  const order: string[] = [];
  const sweepWindows = vi.fn(() => {
    order.push('sweep');
    return Promise.resolve({ ended: 0 });
  });
  const log = {
    log: (e: { msg: string; level: string; fields: Record<string, unknown> }) => {
      logs.push(e);
    },
    child: () => log,
  };
  const d = {
    db: { query: vi.fn(), exec: vi.fn(), transaction: vi.fn(), dialect: 'pglite' },
    clock: fakeClock('2026-11-04T10:00:00.000Z'),
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
  return { d, order };
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

describe('startLoop deliver hook', () => {
  it('calls deliver once per pass, after the windows are swept', async () => {
    const { d, order } = makeDeps();
    const deliver = vi.fn(() => {
      order.push('deliver');
      return Promise.resolve({ fanned_out: 0, attempted: 0, delivered: 0, failed: 0, dead: 0 });
    });
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7, deliver });
    await vi.waitFor(() => expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(3));
    await loop.stop();
    const passes = vi.mocked(runDue).mock.calls.length;
    expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(Math.abs(passes - deliver.mock.calls.length)).toBeLessThanOrEqual(1);
    const body = order.filter((o) => o === 'sweep' || o === 'deliver');
    for (let i = 0; i + 1 < body.length; i += 2)
      expect(body.slice(i, i + 2)).toEqual(['sweep', 'deliver']);
  });

  it('a deliver that throws is logged, does not stop the loop and is not a failed pass', async () => {
    const { d } = makeDeps();
    const deliver = vi.fn(() => Promise.reject(new Error('sink exploded')));
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7, deliver });
    await vi.waitFor(() => expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(3));
    await loop.stop();
    const failed = logs.filter((l) => l.msg === 'jobs.loop.deliver_failed');
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(failed[0]).toMatchObject({ level: 'error', fields: { error: 'sink exploded' } });
    expect(logs.filter((l) => l.msg === 'jobs.loop.pass_failed')).toEqual([]);
    expect(vi.mocked(runDue).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('runs while the outbound PayPal switch is off', async () => {
    const { d } = makeDeps({ paypal_outbound: false });
    const deliver = vi.fn(() =>
      Promise.resolve({ fanned_out: 0, attempted: 0, delivered: 0, failed: 0, dead: 0 }),
    );
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7, deliver });
    await vi.waitFor(() => expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(2));
    await loop.stop();
    expect(vi.mocked(runDue)).not.toHaveBeenCalled();
  });

  it('without the option nothing changes: no deliver log line, passes run as before', async () => {
    const { d } = makeDeps();
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7 });
    await vi.waitFor(() => expect(vi.mocked(runDue).mock.calls.length).toBeGreaterThanOrEqual(2));
    await loop.stop();
    expect(logs.some((l) => l.msg.startsWith('jobs.loop.deliver'))).toBe(false);
  });

  it('stops calling deliver after stop()', async () => {
    const { d } = makeDeps();
    const deliver = vi.fn(() =>
      Promise.resolve({ fanned_out: 0, attempted: 0, delivered: 0, failed: 0, dead: 0 }),
    );
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7, deliver });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
    await loop.stop();
    const n = deliver.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(deliver.mock.calls.length).toBe(n);
  });
});
