// INT-TR0 / TR0.2: a job pass opens its own journal context. The real loop runs on a migrated database
// wrapped with withTraceDb; payments is a stand-in, the window sweep writes one alert per pass. Every
// alert must be journaled as system on the job channel, each pass under a context of its own.
import { describe, expect, it, vi } from 'vitest';
import type { PaymentsDeps } from '@umsbx/contracts';
import { migrate, openDatabase, withTraceDb } from '@umsbx/db';
import { currentTraceContext } from '@umsbx/obs';
import { fakeClock } from '@umsbx/runtime';
import { startLoop } from './loop';

vi.mock('@umsbx/payments', () => ({
  runDue: vi.fn().mockResolvedValue({ processed: 0, still_unknown: 0, expired: 0, abandoned: 0 }),
  recoverOnStartup: vi.fn().mockResolvedValue({ resumed: 0, repaired: 0 }),
  nextDueAt: vi.fn().mockResolvedValue(null),
}));

describe('a job pass', () => {
  it('writes as system on the job channel, one context per pass', async () => {
    const clock = fakeClock('2026-11-04T10:00:00.000Z');
    const raw = await openDatabase({ kind: 'pglite-memory' });
    await migrate(raw, clock);
    const db = withTraceDb(raw, currentTraceContext, clock);
    let n = 0;
    const log = { log: () => undefined, child: () => log };
    const deps = {
      db,
      clock,
      ids: { next: () => 'x', nonce: () => 'n' },
      log,
      audit: { record: () => Promise.resolve() },
      switches: { isOn: () => Promise.resolve(true) },
      config: { abandoned_checkout_ms: 86_400_000 },
      environment: 'dryrun',
      paypal: {},
      content: {},
      sweepWindows: async () => {
        n += 1;
        await db.query(
          `INSERT INTO alerts (id, kind, detail, created_at, updated_at)
           VALUES ($1, 'job_probe', jsonb_build_object('reason', $2::text), '2026-11-04T10:00:00Z', '2026-11-04T10:00:00Z')`,
          [`alr_job_${n}`, `alr_job_${n}`],
        );
        return { ended: 0 };
      },
    } as unknown as Parameters<typeof startLoop>[0];
    try {
      const loop = startLoop(deps as PaymentsDeps & typeof deps, { max_sleep_ms: 5, max_items: 3 });
      await vi.waitFor(() => expect(n).toBeGreaterThanOrEqual(2), { timeout: 5000 });
      await loop.stop();
      const rows = (
        await raw.query<{
          actor_kind: string;
          channel: string;
          ctx_id: string;
          job: string | null;
        }>(
          `SELECT e.actor_kind, e.channel, e.ctx_id, c.job
             FROM trace_events e JOIN trace_context c ON c.id = e.ctx_id
            WHERE e.source_table = 'alerts' AND e.source_id LIKE 'alr_job_%'`,
        )
      ).rows;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((e) => e.actor_kind === 'system' && e.channel === 'job')).toBe(true);
      expect(new Set(rows.map((e) => e.ctx_id)).size).toBe(rows.length); // a context per pass
      expect(rows[0]!.job).toMatch(/\S/);
      const bare = await raw.query(
        "SELECT 1 FROM trace_events WHERE actor_kind = 'unattributed' AND source_table = 'alerts'",
      );
      expect(bare.rows).toEqual([]);
    } finally {
      await raw.close();
    }
  }, 30_000);
});
