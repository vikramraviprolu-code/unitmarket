// POB-M1: the optional `payouts` hook of the job loop. Each pass runs one payout pass after the windows are swept and
// before webhooks are delivered, in its own try/catch. With the paypal_outbound switch off the pass gets NO port (due
// payouts are still created, nothing is sent); with it on the port is wrapped with the lease guard, so a lost lease
// answers `blocked` and the provider is never reached. Without the option the loop is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentsDeps, PayoutPort, PayoutSendRequest, SwitchName } from '@umsbx/contracts';
import { nextDueAt, recoverOnStartup, runDue, runPayoutPass } from '@umsbx/payments';
import { fakeClock } from '@umsbx/runtime';
import { startLoop } from './loop';

vi.mock('@umsbx/payments', () => ({
  runDue: vi.fn(),
  recoverOnStartup: vi.fn(),
  nextDueAt: vi.fn(),
  runPayoutPass: vi.fn(),
}));

const logs: { msg: string; level: string; fields: Record<string, unknown> }[] = [];
const zero = { processed: 0, still_unknown: 0, expired: 0, abandoned: 0 };
const counts = {
  created: 0,
  netted: 0,
  sent: 0,
  failed: 0,
  blocked: 0,
  errored: 0,
  refused: 0,
  expired: 0,
};

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
    clock: fakeClock('2026-11-05T10:00:00.000Z'),
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
const req: PayoutSendRequest = {
  payout_id: 'pay_1',
  idempotency_key: 'umsP-pay_1',
  publisher_id: 'pub_1',
  payee_merchant_id: 'MERCH1',
  amount: { currency: 'USD', minor: 100 },
  environment: 'dryrun',
};
const fakePort = () => {
  const send = vi.fn((_r: PayoutSendRequest) =>
    Promise.resolve({ kind: 'accepted' as const, provider_ref: 'R1', status: 'sent' as const }),
  );
  return { port: { send } as PayoutPort, send };
};
const lease = () => {
  let held = true;
  let lose!: () => void;
  const lost = new Promise<void>((r) => {
    lose = () => {
      held = false;
      r();
    };
  });
  return { held: () => held, lost, release: () => Promise.resolve(), lose };
};

beforeEach(() => {
  logs.length = 0;
  vi.mocked(runDue).mockReset().mockResolvedValue(zero);
  vi.mocked(recoverOnStartup).mockReset().mockResolvedValue({ resumed: 0, repaired: 0 });
  vi.mocked(nextDueAt).mockReset().mockResolvedValue(null);
  vi.mocked(runPayoutPass).mockReset().mockResolvedValue(counts);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('startLoop payouts hook', () => {
  it('runs one payout pass per pass, after the windows are swept and before webhooks', async () => {
    const { d, order } = makeDeps();
    vi.mocked(runPayoutPass).mockImplementation(() => {
      order.push('payouts');
      return Promise.resolve(counts);
    });
    const deliver = vi.fn(() => {
      order.push('deliver');
      return Promise.resolve({});
    });
    const { port } = fakePort();
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7, payouts: { port }, deliver });
    await vi.waitFor(() => expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(3));
    await loop.stop();
    const body = order.filter((o) => ['sweep', 'payouts', 'deliver'].includes(o));
    for (let i = 0; i + 2 < body.length; i += 3)
      expect(body.slice(i, i + 3)).toEqual(['sweep', 'payouts', 'deliver']);
    expect(vi.mocked(runPayoutPass).mock.calls[0]![2]).toMatchObject({ max_items: 7 });
    expect(vi.mocked(runPayoutPass).mock.calls[0]![0]).toBe(d);
  });

  it('with the outbound switch off the pass runs with no port, so payouts are created and none is sent', async () => {
    const { d } = makeDeps({ paypal_outbound: false });
    const { port, send } = fakePort();
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7, payouts: { port } });
    await vi.waitFor(() =>
      expect(vi.mocked(runPayoutPass).mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    await loop.stop();
    for (const c of vi.mocked(runPayoutPass).mock.calls) expect(c[1]).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(vi.mocked(runDue)).not.toHaveBeenCalled(); // the PayPal passes are paused, the payout pass is not
  });

  it('with the switch on the pass gets a port that forwards to the real one', async () => {
    const { d } = makeDeps();
    const { port, send } = fakePort();
    vi.mocked(runPayoutPass).mockImplementation(async (_d, p) => {
      if (p !== null) await p.send(req);
      return counts;
    });
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7, payouts: { port } });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await loop.stop();
    expect(send).toHaveBeenCalledWith(req);
  });

  it('a configured port of null (no payout port in this mode) runs the pass with no port', async () => {
    const { d } = makeDeps();
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7, payouts: { port: null } });
    await vi.waitFor(() =>
      expect(vi.mocked(runPayoutPass).mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    await loop.stop();
    for (const c of vi.mocked(runPayoutPass).mock.calls) expect(c[1]).toBeNull();
  });

  it('a lost lease gives blocked and never reaches the provider', async () => {
    const { d } = makeDeps();
    const { port, send } = fakePort();
    const l = lease();
    let seen: PayoutPort | null = null;
    vi.mocked(runPayoutPass).mockImplementation((_d, p) => {
      seen = p;
      return Promise.resolve(counts);
    });
    const loop = startLoop(d, {
      max_sleep_ms: 5,
      max_items: 7,
      payouts: { port },
      leader: { tryAcquire: vi.fn(() => Promise.resolve(l)) },
      leader_retry_ms: 5,
    });
    await vi.waitFor(() => expect(seen).not.toBeNull());
    const held = seen as unknown as PayoutPort;
    expect(await held.send(req)).toMatchObject({ kind: 'accepted' });
    expect(send).toHaveBeenCalledTimes(1);
    l.lose();
    expect(await held.send(req)).toEqual({ kind: 'blocked', by: 'lease' });
    expect(send).toHaveBeenCalledTimes(1);
    await loop.stop();
  });

  it('a payout pass that throws is logged, does not stop the loop and is not a failed pass', async () => {
    const { d } = makeDeps();
    vi.mocked(runPayoutPass).mockRejectedValue(new Error('ledger exploded'));
    const { port } = fakePort();
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7, payouts: { port } });
    await vi.waitFor(() =>
      expect(vi.mocked(runPayoutPass).mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    await loop.stop();
    const failed = logs.filter((l) => l.msg === 'jobs.loop.payouts_failed');
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(failed[0]).toMatchObject({ level: 'error', fields: { error: 'ledger exploded' } });
    expect(logs.filter((l) => l.msg === 'jobs.loop.pass_failed')).toEqual([]);
    expect(vi.mocked(runDue).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('without the option nothing changes: no payout pass', async () => {
    const { d } = makeDeps();
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7 });
    await vi.waitFor(() => expect(vi.mocked(runDue).mock.calls.length).toBeGreaterThanOrEqual(2));
    await loop.stop();
    expect(runPayoutPass).not.toHaveBeenCalled();
  });

  it('stops running payout passes after stop()', async () => {
    const { d } = makeDeps();
    const { port } = fakePort();
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7, payouts: { port } });
    await vi.waitFor(() => expect(runPayoutPass).toHaveBeenCalled());
    await loop.stop();
    const n = vi.mocked(runPayoutPass).mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(runPayoutPass).mock.calls.length).toBe(n);
  });
});
