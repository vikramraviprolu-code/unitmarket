// INT-TR0 / TR0.5: the journal's cost. The same order-flow transaction (an order update, a mandate update,
// an alert insert and a refund request insert, so four captured writes on two chains and the platform chain)
// is timed with the capture triggers off and with the journal on, interleaved in rounds so drift in the
// machine hits both. The p95 of the journaled run may not exceed the plain p95 by 5 ms or more.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TRACKED_TABLES } from '@umsbx/contracts';
import { systemClock } from '@umsbx/runtime';
import type { Database } from '@umsbx/contracts';
import { as, captureOf, ctx, freshDb, ins, j, seedWorld } from './trace-test-support';
import type { Db } from './trace-test-support';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const ROUNDS = 4;
const PER_ROUND = 40;
const BUDGET_MS = 5;

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await seedWorld(db);
});
afterAll(async () => {
  await db.close();
});

const setCapture = async (on: boolean): Promise<void> => {
  for (const t of TRACKED_TABLES) {
    const c = captureOf(t.table);
    await db.exec(`ALTER TABLE ${c.table} ${on ? 'ENABLE' : 'DISABLE'} TRIGGER ${c.trigger}`);
  }
};

let n = 0;
async function flow(d: Database): Promise<void> {
  n += 1;
  await d.transaction(async (tx) => {
    await tx.query(
      `UPDATE orders SET order_ref = $1, updated_at = '2026-11-04T10:00:00Z'::timestamptz + ($2 || ' seconds')::interval WHERE id = 'ord_1'`,
      [`ref_${n}`, String(n)],
    );
    await tx.query(
      `UPDATE mandates SET max_count = $1, updated_at = '2026-11-04T10:00:00Z'::timestamptz + ($2 || ' seconds')::interval WHERE id = 'man_1'`,
      [5 + (n % 2), String(n)],
    );
    await ins(tx, 'alerts', {
      id: `alr_perf_${n}`,
      kind: 'k',
      order_id: 'ord_1',
      unit_id: null,
      detail: j({ n }),
    });
    await ins(tx, 'refund_requests', {
      id: `rfr_perf_${n}`,
      unit_id: 'unt_1',
      capture_id: 'CAP1',
      amount_minor: 1,
      currency: 'USD',
      reason: 'r',
      requested_by: 'opr_test',
      state: 'requested',
      refund_id: null,
    });
  });
}

// Lint S6 allows only the injected clock, whose resolution is one millisecond. So the flows are timed in
// batches of BATCH and each sample is the mean per flow of one batch (0.25 ms resolution); the p95 is taken
// over those samples. A real slowdown shifts every batch, so it shows; a single slow flow is averaged out.
const BATCH = 4;
const wall = systemClock();
const now = (): number => wall.now().getTime();
const p95 = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

describe('order flow p95', () => {
  // Timing under a loaded machine (the whole packages/db suite in parallel) is noisy; a real regression fails all three tries.
  it('grows by less than 5 ms with the journal on', { retry: 2 }, async () => {
    const plain: number[] = [];
    const journaled: number[] = [];
    const traced = as(db, ctx());
    for (let i = 0; i < 5; i += 1) {
      await setCapture(false);
      await flow(db);
      await setCapture(true);
      await flow(traced);
    }
    const timed = async (target: Database, out: number[]): Promise<void> => {
      for (let i = 0; i < PER_ROUND; i += BATCH) {
        const t0 = now();
        for (let k = 0; k < BATCH; k += 1) await flow(target);
        out.push((now() - t0) / BATCH);
      }
    };
    for (let round = 0; round < ROUNDS; round += 1) {
      await setCapture(false);
      await timed(db, plain);
      await setCapture(true);
      await timed(traced, journaled);
    }
    const before = p95(plain);
    const after = p95(journaled);
    console.log(
      `TRACE-PERF p95 before ${before.toFixed(2)} ms, after ${after.toFixed(2)} ms, growth ${(after - before).toFixed(2)} ms (${plain.length} + ${journaled.length} samples of ${BATCH} flows)`,
    );
    expect(after - before).toBeLessThan(BUDGET_MS);
  });

  it('the journaled runs did write events, so the comparison is not against an empty trigger', async () => {
    const r = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM trace_events WHERE source_id LIKE 'rfr_perf_%'",
    );
    expect(r.rows[0]!.n).toBe(ROUNDS * PER_ROUND + 5);
  });
});
