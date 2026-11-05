// FIX-BOOT-RECOVERY (INT-E2E B3): the recovery pass that `startJobs` runs at boot, before the loop, writes
// under a system journal context on the job channel, with job `recovery`, the same as the loop's own
// recovery (packages/jobs/src/loop.ts). A boot that finds a payment in flight and settles it leaves no
// unattributed journal row (C5, INV-T2). Dry-run model only; no PayPal.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootRefundWorld, buy } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';

vi.mock('server-only', () => ({}));

interface Row {
  key: string;
  source_table: string;
  actor_kind: string;
  channel: string | null;
  order_id: string | null;
  job: string | null;
}

const rows = async (w: RefundWorld): Promise<Row[]> =>
  (
    await w.app.db.query<Row>(
      `SELECT e.chain_key || ':' || e.seq AS key, e.source_table, e.actor_kind, e.channel, e.order_id, c.job
         FROM trace_events e LEFT JOIN trace_context c ON c.id = e.ctx_id`,
    )
  ).rows;

// The server was down past the read-back's retry time: at boot its read is due now.
const readbackDueNow = async (w: RefundWorld, order_id: string): Promise<void> => {
  await w.app.db.query(
    `UPDATE operations SET next_retry_at = '2000-01-01T00:00:00.000Z'
      WHERE order_id = $1 AND kind = 'readback' AND state = 'unknown'`,
    [order_id],
  );
};

/** One server boot: startJobs runs recovery before the loop, then the server stops. The journal rows it wrote. */
const boot = async (w: RefundWorld): Promise<Row[]> => {
  const before = new Set((await rows(w)).map((r) => r.key));
  const jobs = await w.app.startJobs();
  await jobs.stop();
  return (await rows(w)).filter((r) => !before.has(r.key));
};

let w: RefundWorld;
let inFlight: BoughtUnit;
beforeAll(async () => {
  w = await bootRefundWorld();
  // A payment PayPal still reports as pending: the boot recovery reads it and settles it.
  inFlight = await buy(w, {
    offer: 'ferry-timetables',
    option: 'online_read',
    scenario: 'pending_then_completed',
  });
}, 120_000);
afterAll(async () => {
  await w.app.close();
});

describe('startJobs at boot', () => {
  it('runs recovery as system/job/recovery and writes no unattributed journal row', async () => {
    // Two boots: the dry-run scenario answers PENDING to the first read and COMPLETED to the second.
    await readbackDueNow(w, inFlight.order_id);
    const first = await boot(w);
    await readbackDueNow(w, inFlight.order_id);
    const written = [...first, ...(await boot(w))];

    const unattributed = written
      .filter((r) => r.actor_kind === 'unattributed')
      .map((r) => r.source_table)
      .sort();
    expect(unattributed, 'unattributed rows written at boot').toEqual([]);

    // Recovery settled the in-flight payment: the sale rows exist and were written by recovery.
    const tables = new Set(written.map((r) => r.source_table));
    for (const t of ['provider_calls', 'order_units', 'entitlements', 'ledger_entries']) {
      expect(tables.has(t), `recovery wrote ${t}`).toBe(true);
    }
    for (const r of written) {
      expect(r, r.source_table).toMatchObject({
        actor_kind: 'system',
        channel: 'job',
        job: 'recovery',
      });
    }
  });
});
