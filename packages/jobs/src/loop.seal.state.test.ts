// INT-TR1 / TR1.6: the job loop seals the previous UTC day once. The seal runs in a job context of its own:
// actor system, channel job, job seal. The clock is a fake one, so the first pass is at 00:05 and the second
// is the same day.
import { describe, expect, it, vi } from 'vitest';
import type { Database, PaymentsDeps, SqlExecutor } from '@umsbx/contracts';
import { migrate, openDatabase, verifyTrace, withTraceDb } from '@umsbx/db';
import { currentTraceContext } from '@umsbx/obs';
import { fakeClock } from '@umsbx/runtime';
import { startLoop } from './loop';

vi.mock('@umsbx/payments', () => ({
  runDue: vi.fn().mockResolvedValue({ processed: 0, still_unknown: 0, expired: 0, abandoned: 0 }),
  recoverOnStartup: vi.fn().mockResolvedValue({ resumed: 0, repaired: 0 }),
  nextDueAt: vi.fn().mockResolvedValue(null),
}));

describe('the seal step of the job loop', () => {
  it('seals the previous day on the first pass after 00:05, once, under system/job/seal', async () => {
    const clock = fakeClock('2026-11-05T00:05:00.000Z');
    const raw = await openDatabase({ kind: 'pglite-memory' });
    await migrate(raw, clock);
    const traced = withTraceDb(raw, currentTraceContext, clock);
    const seen: { actor_kind: string; channel: string; job: string }[] = [];
    // Records the journal setting of the transaction that calls trace_seal.
    const db = new Proxy(traced, {
      get(t, p) {
        if (p !== 'transaction') {
          const v: unknown = Reflect.get(t, p, t);
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        }
        return <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> =>
          (t as Database).transaction(async (tx) => {
            const out = await fn(tx);
            const s = (
              await tx.query<{ s: string | null }>(`SELECT current_setting('ums.trace', true) AS s`)
            ).rows[0]!.s;
            if (s !== null && s !== '') seen.push(JSON.parse(s) as (typeof seen)[number]);
            return out;
          });
      },
    }) as Database;
    let passes = 0;
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
        passes += 1;
        return { ended: 0 };
      },
    } as unknown as Parameters<typeof startLoop>[0];
    try {
      const loop = startLoop(deps as PaymentsDeps & typeof deps, { max_sleep_ms: 5, max_items: 3 });
      await vi.waitFor(() => expect(passes).toBeGreaterThanOrEqual(3), { timeout: 5000 });
      await loop.stop();
      const rows = (
        await raw.query<{ day: string }>(
          `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM trace_seals`,
        )
      ).rows;
      expect(rows).toEqual([{ day: '2026-11-04' }]);
      const mine = seen.filter((s) => s.job === 'seal');
      expect(mine.length).toBeGreaterThanOrEqual(1);
      for (const s of mine)
        expect([s.actor_kind, s.channel, s.job]).toEqual(['system', 'job', 'seal']);
      expect((await verifyTrace(raw)).findings).toEqual([]);
    } finally {
      await raw.close();
    }
  }, 30_000);
});
