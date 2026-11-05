// INT-TR0 / TR0.4: restore. A logical export of a journaled database loads into a freshly migrated one
// with the journal intact: same events, no duplicate (chain_key, seq), the migration's own backfill rows
// replaced by the exported ones, and nothing written twice by the capture triggers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exportSql,
  expectedTriggers,
  guardProblems,
  importSql,
  tablesInDependencyOrder,
} from './export-sql';
import { traceInvariants, verifyTrace } from './trace-verify';
import {
  EVENTS_GUARD,
  HASH,
  T15,
  allEvents,
  as,
  clock,
  countEvents,
  ctx,
  freshDb,
  ins,
  j,
  seedWorld,
  updateWorld,
  withTriggersOff,
} from './trace-test-support';
import type { Db } from './trace-test-support';

let source: Db;
let sql: string;
beforeAll(async () => {
  source = await freshDb();
  await seedWorld(source);
  await updateWorld(source);
  sql = await exportSql(source, { utc: '2026-11-04T12:00:00Z' });
});
afterAll(async () => {
  await source.close();
});

const backfillOf = async (d: Db) =>
  (
    await d.query<{ chain_key: string; seq: number }>(
      "SELECT chain_key, seq::int FROM trace_events WHERE channel = 'backfill' ORDER BY chain_key, seq",
    )
  ).rows;

describe('export, import, verify', () => {
  it('starts from a freshly migrated database: it already holds the seven backfill events of the seeded switches', async () => {
    const d = await freshDb();
    try {
      const rows = await backfillOf(d);
      expect(rows).toHaveLength(7);
      expect(rows.every((r) => r.chain_key === 'plat')).toBe(true);
    } finally {
      await d.close();
    }
  });

  it('imports into a fresh database, verifies clean, and holds the same events as the source', async () => {
    const target = await freshDb();
    try {
      await importSql(target, sql);
      const r = await verifyTrace(target);
      expect(r.findings).toEqual([]);
      expect(r.rows).toBe(await countEvents(source));
      expect(await allEvents(target)).toEqual(await allEvents(source));
      expect(await traceInvariants(target)).toEqual([]);
    } finally {
      await target.close();
    }
  });

  it('leaves no duplicate (chain_key, seq) and the backfill rows are exactly the source’s', async () => {
    const target = await freshDb();
    try {
      await importSql(target, sql);
      const dup = await target.query(
        'SELECT chain_key, seq FROM trace_events GROUP BY chain_key, seq HAVING count(*) > 1',
      );
      expect(dup.rows).toEqual([]);
      expect(await backfillOf(target)).toEqual(await backfillOf(source));
      expect(await backfillOf(target)).toHaveLength(7);
    } finally {
      await target.close();
    }
  });

  it('carries trace_heads, trace_context and trace_seals across; trace_tracked is not exported', async () => {
    const s = await freshDb();
    const target = await freshDb();
    try {
      await seedWorld(s);
      await updateWorld(s);
      await s.query("SELECT trace_seal('2026-11-03', '2026-11-04T00:00:05Z')");
      const text = await exportSql(s, { utc: '2026-11-04T12:00:00Z' });
      expect(text).not.toContain('INSERT INTO "trace_tracked"');
      expect(text).toContain('INSERT INTO "trace_events"');
      await importSql(target, text);
      for (const t of ['trace_heads', 'trace_context', 'trace_seals']) {
        const a = await s.query(`SELECT count(*)::int AS n FROM ${t}`);
        const b = await target.query(`SELECT count(*)::int AS n FROM ${t}`);
        expect(b.rows).toEqual(a.rows);
      }
      expect(await tablesInDependencyOrder(target)).toContain('trace_tracked');
      const tracked = await target.query('SELECT count(*)::int AS n FROM trace_tracked');
      expect(tracked.rows[0]).toEqual({ n: 27 });
      expect((await verifyTrace(target)).findings).toEqual([]);
    } finally {
      await s.close();
      await target.close();
    }
  });

  it('journals nothing while it loads: the target gains no event beyond the imported ones', async () => {
    const target = await freshDb();
    try {
      const before = await countEvents(target);
      await importSql(target, sql);
      expect(before).toBe(7);
      expect(await countEvents(target)).toBe(await countEvents(source));
    } finally {
      await target.close();
    }
  });

  it('after the import the journal is live again: the next write lands at the next seq of its chain', async () => {
    const target = await freshDb();
    try {
      await importSql(target, sql);
      const last = (
        await target.query<{ seq: number }>(
          "SELECT seq::int FROM trace_heads WHERE chain_key = 'buy:buy_1'",
        )
      ).rows[0]!.seq;
      // apr_1 is already used and frozen, so the next write on the buyer chain is a new approval.
      await ins(as(target, ctx(), clock), 'approvals', {
        id: 'apr_after',
        buyer_id: 'buy_1',
        snapshot: j({ v: 1 }),
        content_hash: HASH,
        nonce: 'nonce_after',
        expires_at: T15,
        used_at: null,
        environment: 'dryrun',
      });
      const next = (
        await target.query<{ seq: number }>(
          "SELECT seq::int FROM trace_heads WHERE chain_key = 'buy:buy_1'",
        )
      ).rows[0]!.seq;
      expect(next).toBe(last + 1);
      expect((await verifyTrace(target)).findings).toEqual([]);
    } finally {
      await target.close();
    }
  });

  it('triggers are all on and expectedTriggers lists the journal triggers', async () => {
    const target = await freshDb();
    try {
      await importSql(target, sql);
      const expected = await expectedTriggers(clock);
      expect(expected).toContain('trace_events_append_only');
      expect(expected).toContain('trace_capture_orders');
      expect(expected).toContain('trace_capture_ledger_entries');
      expect(await guardProblems(target, expected)).toEqual([]);
      await target.exec(`ALTER TABLE trace_events DISABLE TRIGGER trace_events_append_only`);
      expect((await guardProblems(target, expected)).join(' ')).toContain(
        'trace_events_append_only',
      );
    } finally {
      await target.close();
    }
  });
});

describe('what a restore refuses and what it reports', () => {
  it('refuses a journal whose row_hash was edited: INV-T1 breaks the import', async () => {
    const s = await freshDb();
    const target = await freshDb();
    try {
      await seedWorld(s);
      await withTriggersOff(s, [EVENTS_GUARD], async () => {
        await s.exec(
          "UPDATE trace_events SET row_hash = '" +
            'c'.repeat(64) +
            "' WHERE chain_key = 'buy:buy_1' AND seq = 1",
        );
      });
      const text = await exportSql(s, { utc: '2026-11-04T12:00:00Z' });
      await expect(importSql(target, text)).rejects.toThrow(/INV-T1/);
      expect((await target.query('SELECT 1 FROM orders')).rows).toEqual([]);
    } finally {
      await s.close();
      await target.close();
    }
  });

  it('an unattributed row does not block a restore; it is reported by INV-T2 afterwards', async () => {
    const s = await freshDb();
    const target = await freshDb();
    try {
      await seedWorld(s);
      await updateWorld(s);
      await ins(s, 'alerts', {
        id: 'alr_bare',
        kind: 'k',
        order_id: null,
        unit_id: null,
        detail: j({}),
      });
      const text = await exportSql(s, { utc: '2026-11-04T12:00:00Z' });
      await importSql(target, text);
      const lines = await traceInvariants(target);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^INV-T2 .*alr_bare/);
      expect((await verifyTrace(target)).findings).toEqual([]);
    } finally {
      await s.close();
      await target.close();
    }
  });

  it('refuses a database that already holds an event that is not a backfill row', async () => {
    const target = await freshDb();
    try {
      await ins(as(target, ctx()), 'alerts', {
        id: 'alr_pre',
        kind: 'k',
        order_id: null,
        unit_id: null,
        detail: j({}),
      });
      await expect(importSql(target, sql)).rejects.toThrow(/not empty/);
    } finally {
      await target.close();
    }
  });

  it('restore mode alone is not an escape: a session that sets it still cannot delete or edit journal rows', async () => {
    const d = await freshDb();
    try {
      await d.exec(`SELECT set_config('ums.trace', '{"mode":"restore"}', false)`);
      try {
        await expect(
          d.query("DELETE FROM trace_events WHERE channel = 'backfill'"),
        ).rejects.toThrow(/append-only/);
        await expect(d.query('UPDATE trace_events SET mfa = NOT mfa')).rejects.toThrow(
          /append-only/,
        );
      } finally {
        await d.exec(`SELECT set_config('ums.trace', '', false)`);
      }
      expect(await countEvents(d)).toBe(7);
    } finally {
      await d.close();
    }
  });
});
