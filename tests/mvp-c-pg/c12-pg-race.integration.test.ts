// PG-2 (D-045 retired for these paths): capture, poll, refund and sweeper racing on ONE order, on a real
// Postgres 16 (a throwaway server on a unix socket). Each round is a fresh database and a fresh app with
// the C rig's fake Wire (no byte leaves the process); the racers start in a seeded order. After every
// round: one transition, one sale, one capture sent, INV1 to INV7 hold, and no lock failure (40P01,
// 40001) was left unretried. Runs only when UMS_TEST_PG_BIN is set.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkInvariants } from '@umsbx/payments';
import {
  buy,
  delivery,
  eventBody,
  nowTransmissionTime,
  orderStatus,
  placeAndCheckout,
  postRefund,
} from '../mvp-c/c-support';
import type { CRig } from '../mvp-c/c-support';
import {
  PG_ON,
  assertNoRejection,
  bootPgRig,
  lockFailures,
  race,
  seeded,
  sleep,
  startTestPostgres,
} from './pg-support';
import type { TestPostgres } from './pg-support';

vi.mock('server-only', () => ({}));

const CAPTURE_ROUNDS = 20;
const REFUND_ROUNDS = 20;
const OFFERS = ['knot-notebook', 'ferry-timetables', 'harbour-fees', 'tide-tables'] as const;

describe.skipIf(!PG_ON)('PG-2 races on real Postgres', () => {
  let server: TestPostgres;
  beforeAll(async () => {
    server = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
  });

  const invariants = async (rig: CRig) => {
    const all = await checkInvariants(rig.app.db);
    expect(all.map((v) => v.id)).toEqual(['INV1', 'INV2', 'INV3', 'INV4', 'INV5', 'INV6', 'INV7']);
    expect(all.filter((v) => !v.ok)).toEqual([]);
  };
  const count = (rig: CRig, sql: string, p: unknown[] = []) => rig.count(sql, p);
  const hook = (o: { order: string; n: string }) =>
    delivery(
      eventBody({
        id: `WH-PG2-${o.n}`,
        type: 'PAYMENT.CAPTURE.COMPLETED',
        order: o.order,
        capture: `${o.order}CAP1`,
      }),
      { id: `TR-PG2-${o.n}`, time: nowTransmissionTime() },
    );
  const captureSends = (rig: CRig, providerOrder: string) =>
    rig.sent.filter((r) => r.method === 'POST' && r.url.endsWith(`/${providerOrder}/capture`));

  let capturesRun = 0;
  it(`capture, poll, webhook and sweeper on one order: ${CAPTURE_ROUNDS} rounds, one paid transition, one sale`, async () => {
    for (let round = 0; round < CAPTURE_ROUNDS; round += 1) {
      const rnd = seeded(1000 + round);
      const pr = await bootPgRig(server);
      try {
        const { rig } = pr;
        const lost = round % 2 === 1; // odd rounds: the capture answer is lost, a read-back must settle it
        const placed = await placeAndCheckout(rig, {
          offer: OFFERS[round % OFFERS.length]!,
          option: 'online_read',
          scenario: lost ? 'lost_capture_response' : 'happy',
        });
        let jobs: { stop(): Promise<void> } | null = null;
        let pumping = true;
        const pump = (async () => {
          // keeps a lost capture's read-back due while the racers run
          while (pumping) {
            await rig.app.db.query(
              `UPDATE operations SET next_retry_at = '2000-01-01T00:00:00Z' WHERE order_id = $1 AND state = 'unknown'`,
              [placed.order_id],
            );
            await sleep(40);
          }
        })();
        const results = await race(rnd, [
          () =>
            rig.app.engine.payments.onBuyerReturn({
              order_ref: placed.order_ref,
              actor: rig.buyer,
            }),
          () =>
            rig.app.engine.payments.onBuyerReturn({
              order_ref: placed.order_ref,
              actor: rig.buyer,
            }),
          () => rig.post(hook({ order: placed.provider_order_id, n: `${round}a` }), '203.0.113.11'),
          () => rig.post(hook({ order: placed.provider_order_id, n: `${round}b` }), '203.0.113.12'),
          async () => {
            jobs = await rig.app.startJobs();
          },
          () => rig.app.engine.sweep(),
          () => rig.app.engine.sweep(),
        ]);
        try {
          assertNoRejection(results, `capture round ${round}`);
          await vi.waitFor(
            async () => expect(await orderStatus(rig, placed.order_id)).toBe('paid'),
            {
              timeout: 40_000,
              interval: 100,
            },
          );
          await vi.waitFor(
            async () =>
              expect(
                await count(
                  rig,
                  `SELECT count(*) AS c FROM operations WHERE order_id = $1 AND state IN ('prepared','sent','unknown')`,
                  [placed.order_id],
                ),
              ).toBe(0),
            { timeout: 40_000, interval: 100 },
          );
        } finally {
          pumping = false;
          await pump;
          await (jobs as { stop(): Promise<void> } | null)?.stop();
        }
        const q = (sql: string) => count(rig, sql, [placed.order_id]);
        expect(
          {
            sales: await q(
              `SELECT count(*) AS c FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1 AND l.kind = 'sale'`,
            ),
            capture_ids: await q(
              'SELECT count(DISTINCT capture_id) AS c FROM order_units WHERE order_id = $1 AND capture_id IS NOT NULL',
            ),
            entitlements: await q(
              'SELECT count(*) AS c FROM entitlements e JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1',
            ),
            receipts: await q('SELECT count(*) AS c FROM receipts WHERE order_id = $1'),
          },
          `round ${round} (${lost ? 'lost answer' : 'happy'})`,
        ).toEqual({ sales: 1, capture_ids: 1, entitlements: 1, receipts: 1 });
        // PayPal-Request-Id is deterministic: however many sends there were, they share one key
        const keys = new Set(
          captureSends(rig, placed.provider_order_id).map(
            (r) => r.headers['PayPal-Request-Id'] ?? r.headers['paypal-request-id'],
          ),
        );
        expect(keys.size, `round ${round}: capture request ids`).toBe(1);
        if (!lost)
          expect(
            captureSends(rig, placed.provider_order_id),
            `round ${round}: capture sends`,
          ).toHaveLength(1);
        expect(lockFailures(rig.lines), `round ${round}`).toEqual([]);
        await invariants(rig);
        capturesRun += 1;
      } finally {
        await pr.close();
      }
    }
    expect(capturesRun).toBe(CAPTURE_ROUNDS);
    process.stdout.write(`PG2_RACE_ROUNDS capture=${capturesRun}\n`);
  }, 900_000);

  let refundsRun = 0;
  it(`refund, poll, webhook and sweeper on one paid order: ${REFUND_ROUNDS} rounds, one refund, books balance`, async () => {
    for (let round = 0; round < REFUND_ROUNDS; round += 1) {
      const rnd = seeded(5000 + round);
      const pr = await bootPgRig(server);
      try {
        const { rig } = pr;
        const op = await rig.operator('vikram');
        const u = await buy(rig, {
          offer: OFFERS[round % OFFERS.length]!,
          option: round % 2 === 0 ? 'online_read' : 'keep_retrieve',
        });
        expect(await orderStatus(rig, u.order_id)).toBe('paid');
        let jobs: { stop(): Promise<void> } | null = null;
        const results = await race(rnd, [
          () =>
            postRefund(rig, op, {
              unit_id: u.unit_id,
              amount_minor: null,
              reason: `PG2 race ${round} a`,
            }),
          () =>
            postRefund(rig, op, {
              unit_id: u.unit_id,
              amount_minor: null,
              reason: `PG2 race ${round} b`,
            }),
          () => rig.post(hook({ order: u.provider_order_id, n: `r${round}` }), '203.0.113.21'),
          async () => {
            jobs = await rig.app.startJobs();
          },
          () => rig.app.engine.sweep(),
          () => rig.app.engine.sweep(),
        ]);
        try {
          assertNoRejection(results, `refund round ${round}`);
          await vi.waitFor(
            async () => {
              const open = await count(
                rig,
                `SELECT count(*) AS c FROM refund_requests WHERE unit_id = $1 AND state IN ('requested','sent','unknown','pending')`,
                [u.unit_id],
              );
              const done = await count(
                rig,
                `SELECT count(*) AS c FROM ledger_entries WHERE unit_id = $1 AND kind = 'refund'`,
                [u.unit_id],
              );
              expect(open).toBe(0);
              expect(done).toBeGreaterThanOrEqual(1);
            },
            { timeout: 40_000, interval: 100 },
          );
        } finally {
          await (jobs as { stop(): Promise<void> } | null)?.stop();
        }
        const refunded = Number(
          (
            await rig.app.db.query<{ r: string | number }>(
              `SELECT coalesce(sum(amount_minor), 0) AS r FROM ledger_entries WHERE unit_id = $1 AND kind = 'refund'`,
              [u.unit_id],
            )
          ).rows[0]?.r,
        );
        expect(refunded, `round ${round}: refunded in the ledger`).toBe(u.amount_minor);
        expect(
          await count(
            rig,
            `SELECT count(*) AS c FROM ledger_entries WHERE unit_id = $1 AND kind = 'refund'`,
            [u.unit_id],
          ),
          `round ${round}: refund ledger rows`,
        ).toBe(1);
        expect(
          await count(
            rig,
            `SELECT count(*) AS c FROM ledger_entries WHERE unit_id = $1 AND kind = 'sale'`,
            [u.unit_id],
          ),
        ).toBe(1);
        expect(
          rig.ops().filter((o) => o === 'refund_capture'),
          `round ${round}: refunds sent to PayPal`,
        ).toHaveLength(1);
        expect(
          (
            await rig.app.db.query<{ money_state: string; access_state: string }>(
              'SELECT money_state, access_state FROM entitlements WHERE id = $1',
              [u.entitlement_id],
            )
          ).rows[0],
        ).toMatchObject({ money_state: 'refunded', access_state: 'revoked' });
        expect(lockFailures(rig.lines), `round ${round}`).toEqual([]);
        await invariants(rig);
        refundsRun += 1;
      } finally {
        await pr.close();
      }
    }
    expect(refundsRun).toBe(REFUND_ROUNDS);
    process.stdout.write(`PG2_RACE_ROUNDS refund=${refundsRun}\n`);
  }, 900_000);
});
