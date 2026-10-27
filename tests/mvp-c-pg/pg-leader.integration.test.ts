// PG-2: one job loop at a time. Two apps on ONE Postgres database: only the holder of the session
// advisory lock runs passes; a graceful stop, a close and a dropped lock connection each hand the loop
// over within a bounded time. Then the contrast: two loops WITHOUT the lock (test seam) race a lost
// capture answer and still send one deterministic PayPal-Request-Id and book one sale.
// Runs only when UMS_TEST_PG_BIN is set; a throwaway server on a unix socket.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkInvariants } from '@umsbx/payments';
import { createApp } from '../../apps/web/composition.server';
import type { App } from '../../apps/web/composition.server';
import { testEnv } from '../../apps/web/src/support';
import {
  APPROVAL_REF,
  FAKE_ID,
  FAKE_SECRET,
  TOTP_KEYS,
  orderStatus,
  paypalWire,
  placeAndCheckout,
} from '../mvp-c/c-support';
import { PG_ON, bootPgRig, sleep, startTestPostgres } from './pg-support';
import type { TestPostgres } from './pg-support';

vi.mock('server-only', () => ({}));

interface Node {
  app: App;
  lines: string[];
  jobs: { stop(): Promise<void> } | null;
}

describe.skipIf(!PG_ON)('PG-2 job loop leader on real Postgres', () => {
  let server: TestPostgres;
  const nodes: Node[] = [];
  const dbs: string[] = [];
  beforeAll(async () => {
    server = await startTestPostgres();
  }, 120_000);
  afterEach(async () => {
    for (const n of nodes.splice(0)) {
      await n.jobs?.stop().catch(() => undefined);
      await n.app.close().catch(() => undefined);
    }
    for (const d of dbs.splice(0)) await server.dropDatabase(d).catch(() => undefined);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const freshUrl = async (): Promise<string> => {
    const c = await server.createDatabase('ums_lead');
    dbs.push(c.name);
    return c.url;
  };
  const node = async (
    url: string,
    loop: { leader?: 'off'; leader_retry_ms?: number } = { leader_retry_ms: 100 },
  ): Promise<Node> => {
    const lines: string[] = [];
    const app = createApp(await testEnv({ UMS_DB: 'postgres', DATABASE_URL: url }), {
      switch_cache_ms: 0,
      log_sink: (l) => lines.push(l),
      test_loop: loop,
    });
    await app.ready();
    const n: Node = { app, lines, jobs: null };
    nodes.push(n);
    return n;
  };
  const passAt = async (n: Node) => (await n.app.health()).last_pass_at;
  const acquired = (n: Node) =>
    n.lines.filter((l) => l.includes('jobs.loop.leader_acquired')).length;
  const lost = (n: Node) => n.lines.filter((l) => l.includes('jobs.loop.leader_lost')).length;
  /** Which nodes completed a pass since `before` was read. */
  const advancing = async (ns: Node[], ms: number): Promise<boolean[]> => {
    const before = await Promise.all(ns.map(passAt));
    await sleep(ms);
    const after = await Promise.all(ns.map(passAt));
    return after.map((a, i) => a !== null && a !== before[i]);
  };
  const killLockHolders = (n: Node) =>
    n.app.db.query(
      `SELECT pg_terminate_backend(l.pid) FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.granted AND l.pid <> pg_backend_pid()`,
    );

  it('two loops on one database: exactly one runs passes, and one election is logged', async () => {
    const url = await freshUrl();
    const a = await node(url);
    const b = await node(url);
    [a.jobs, b.jobs] = await Promise.all([a.app.startJobs(), b.app.startJobs()]);
    await vi.waitFor(async () => expect((await passAt(a)) ?? (await passAt(b))).not.toBeNull(), {
      timeout: 10_000,
      interval: 50,
    });
    const moving = await advancing([a, b], 1_500);
    expect(moving.filter(Boolean)).toHaveLength(1);
    expect(acquired(a) + acquired(b)).toBe(1);
  }, 60_000);

  it('a graceful stop of the leader hands the loop to the other within a bounded time', async () => {
    const url = await freshUrl();
    const a = await node(url);
    const b = await node(url);
    a.jobs = await a.app.startJobs();
    await vi.waitFor(async () => expect(await passAt(a)).not.toBeNull(), {
      timeout: 10_000,
      interval: 50,
    });
    b.jobs = await b.app.startJobs();
    await sleep(500);
    expect(await passAt(b)).toBeNull(); // a leads; b waits
    const t0 = Date.now();
    await a.jobs.stop();
    a.jobs = null;
    await vi.waitFor(async () => expect(await passAt(b)).not.toBeNull(), {
      timeout: 8_000,
      interval: 50,
    });
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(acquired(b)).toBe(1);
  }, 60_000);

  it('closing the leader app releases the lock too', async () => {
    const url = await freshUrl();
    const a = await node(url);
    const b = await node(url);
    a.jobs = await a.app.startJobs();
    await vi.waitFor(async () => expect(await passAt(a)).not.toBeNull(), {
      timeout: 10_000,
      interval: 50,
    });
    b.jobs = await b.app.startJobs();
    await a.app.close();
    a.jobs = null;
    await vi.waitFor(async () => expect(await passAt(b)).not.toBeNull(), {
      timeout: 8_000,
      interval: 50,
    });
  }, 60_000);

  it('a dropped lock connection stops the leader at once; the loop re-elects and still only one runs', async () => {
    const url = await freshUrl();
    const a = await node(url);
    const b = await node(url);
    a.jobs = await a.app.startJobs();
    await vi.waitFor(async () => expect(await passAt(a)).not.toBeNull(), {
      timeout: 10_000,
      interval: 50,
    });
    b.jobs = await b.app.startJobs();
    await sleep(300);
    await killLockHolders(b); // the leader's lock session dies (a crash, a failover, a network drop)
    await vi.waitFor(() => expect(lost(a)).toBe(1), { timeout: 5_000, interval: 25 });
    // someone leads again, and never two at a time
    await vi.waitFor(async () => expect((await advancing([a, b], 600)).some(Boolean)).toBe(true), {
      timeout: 15_000,
      interval: 50,
    });
    for (let i = 0; i < 3; i += 1)
      expect((await advancing([a, b], 500)).filter(Boolean)).toHaveLength(1);
    expect(acquired(a) + acquired(b)).toBe(2); // the first term and the new one
  }, 90_000);

  it('the test seam that turns the lock off lets both loops run (the contrast for the double-send test)', async () => {
    const url = await freshUrl();
    const a = await node(url, { leader: 'off' });
    const b = await node(url, { leader: 'off' });
    [a.jobs, b.jobs] = await Promise.all([a.app.startJobs(), b.app.startJobs()]);
    await vi.waitFor(async () => expect((await advancing([a, b], 600)).every(Boolean)).toBe(true), {
      timeout: 10_000,
      interval: 50,
    });
    expect(acquired(a) + acquired(b)).toBe(0);
  }, 60_000);

  it('two loops WITHOUT the lock racing a lost capture answer: one request id, one sale, books balance', async () => {
    const pr = await bootPgRig(server); // places the order and plays the buyer; its own loop never starts
    try {
      const { rig } = pr;
      const placed = await placeAndCheckout(rig, {
        offer: 'knot-notebook',
        option: 'online_read',
        scenario: 'lost_capture_response',
      });
      await rig.app.engine.payments.onBuyerReturn({
        order_ref: placed.order_ref,
        actor: rig.buyer,
      });
      expect(await orderStatus(rig, placed.order_id)).not.toBe('paid');
      await rig.app.db.query(
        `UPDATE operations SET next_retry_at = '2000-01-01T00:00:00Z' WHERE order_id = $1 AND state = 'unknown'`,
        [placed.order_id],
      );
      const env = await testEnv({
        UMS_MODE: 'sandbox',
        UMS_PAYPAL_CONNECT: 'on',
        UMS_OUTBOUND_APPROVAL_REF: APPROVAL_REF,
        UMS_OUTBOUND_SCOPE: 'mvp_c_refunds',
        PAYPAL_CLIENT_ID: FAKE_ID,
        PAYPAL_CLIENT_SECRET: FAKE_SECRET,
        PAYPAL_WEBHOOK_ID: 'SYN-WEBHOOK-ID-0001',
        UMS_TRUSTED_PROXIES: '1',
        UMS_OPERATOR_TOTP_KEYS: TOTP_KEYS,
        UMS_DB: 'postgres',
        DATABASE_URL: pr.url,
      });
      const wires = [paypalWire(rig.model), paypalWire(rig.model)];
      const loops: Node[] = [];
      for (const w of wires) {
        const lines: string[] = [];
        const app = createApp(env, {
          switch_cache_ms: 0,
          log_sink: (l) => lines.push(l),
          test_wire: w.wire,
          webhook_certificates: rig.certs,
          test_loop: { leader: 'off' },
        });
        await app.ready();
        const n: Node = { app, lines, jobs: null };
        nodes.push(n);
        loops.push(n);
      }
      [loops[0]!.jobs, loops[1]!.jobs] = await Promise.all(loops.map((n) => n.app.startJobs()));
      await vi.waitFor(async () => expect(await orderStatus(rig, placed.order_id)).toBe('paid'), {
        timeout: 40_000,
        interval: 100,
      });
      await vi.waitFor(
        async () =>
          expect(
            await rig.count(
              `SELECT count(*) AS c FROM operations WHERE order_id = $1 AND state IN ('prepared','sent','unknown')`,
              [placed.order_id],
            ),
          ).toBe(0),
        { timeout: 40_000, interval: 100 },
      );
      for (const n of loops) await n.jobs?.stop();
      const sends = [rig.sent, wires[0]!.sent, wires[1]!.sent]
        .flat()
        .filter(
          (r) => r.method === 'POST' && r.url.endsWith(`/${placed.provider_order_id}/capture`),
        );
      const keys = new Set(
        sends.map((r) => r.headers['PayPal-Request-Id'] ?? r.headers['paypal-request-id']),
      );
      expect(keys.size).toBe(1);
      expect(keys.has(undefined)).toBe(false);
      // the first send plus at most one same-key resend after the lost answer
      expect(sends.length).toBeLessThanOrEqual(2);
      expect(
        await rig.count(
          `SELECT count(*) AS c FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1 AND l.kind = 'sale'`,
          [placed.order_id],
        ),
      ).toBe(1);
      expect((await checkInvariants(rig.app.db)).filter((v) => !v.ok)).toEqual([]);
    } finally {
      await pr.close();
    }
  }, 120_000);
});
