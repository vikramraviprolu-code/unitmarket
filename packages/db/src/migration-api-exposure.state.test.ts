// INT-CTL / CTL.4: migration 0026 on a real database. The table is seeded on with epoch times, a row is never
// deleted or truncated, the journal holds the seeds as imports and one event per change, and a logical export
// loads into a fresh database with the exposure rows intact.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_GROUPS } from '@umsbx/contracts';
import { exportSql, importSql } from './export-sql';
import { traceInvariants, verifyTrace } from './trace-verify';
import { T2, as, clock, ctx, eventsOf, freshDb } from './trace-test-support';
import type { Db } from './trace-test-support';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

const rows = async (d: Db) =>
  (
    await d.query<{
      group_name: string;
      enabled: boolean;
      changed_by: string | null;
      reason_code: string | null;
      changed_at: Date | string;
      created_at: Date | string;
      updated_at: Date | string;
    }>('SELECT * FROM api_exposure ORDER BY group_name')
  ).rows;
const iso = (v: Date | string): string => new Date(v).toISOString();

describe('the seed', () => {
  it('holds one row per group, all enabled, with all three times at the epoch', async () => {
    const r = await rows(db);
    expect(r.map((x) => x.group_name).sort()).toEqual([...API_GROUPS].sort());
    for (const x of r) {
      expect(x.enabled, x.group_name).toBe(true);
      expect(iso(x.changed_at)).toBe('1970-01-01T00:00:00.000Z');
      expect(iso(x.created_at)).toBe('1970-01-01T00:00:00.000Z');
      expect(iso(x.updated_at)).toBe('1970-01-01T00:00:00.000Z');
      expect(x.reason_code).toBeNull();
    }
  });

  it('refuses a group name outside the list and a reason code outside the list', async () => {
    await expect(
      db.query(
        "INSERT INTO api_exposure (group_name, enabled, changed_at, created_at, updated_at) VALUES ('payments', true, now(), now(), now())",
      ),
    ).rejects.toThrow();
    await expect(
      db.query("UPDATE api_exposure SET reason_code = 'because' WHERE group_name = 'orders'"),
    ).rejects.toThrow();
  });

  it('DELETE and TRUNCATE raise, and an UPDATE still works', async () => {
    await expect(
      db.query("DELETE FROM api_exposure WHERE group_name = 'orders'"),
    ).rejects.toThrow();
    await expect(db.exec('TRUNCATE api_exposure')).rejects.toThrow();
    const names = await db.query(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'api_exposure'::regclass AND tgname IN ('api_exposure_no_delete', 'api_exposure_no_truncate') ORDER BY tgname",
    );
    expect(names.rows).toEqual([
      { tgname: 'api_exposure_no_delete' },
      { tgname: 'api_exposure_no_truncate' },
    ]);
  });
});

describe('the journal', () => {
  it('journals the seeds as system/backfill imports and verifies clean after migrate', async () => {
    const d = await freshDb();
    try {
      const imports = await d.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM trace_events WHERE source_table = 'api_exposure' AND event_type = 'api_exposure.imported' AND actor_kind = 'system' AND channel = 'backfill'",
      );
      expect(imports.rows[0]!.n).toBe(API_GROUPS.length);
      expect(await traceInvariants(d)).toEqual([]);
      expect((await verifyTrace(d)).findings).toEqual([]);
    } finally {
      await d.close();
    }
  });

  it('a change writes exactly one event with the operator, the web channel, a hashed changer and no free text', async () => {
    const d = await freshDb();
    try {
      const before = (await eventsOf(d, 'api_exposure', 'mcp:buy_unit')).length;
      const c = ctx({ channel: 'web', actor_kind: 'operator', actor_id: 'opr_ctl', mfa: false });
      await as(d, c, clock).query(
        "UPDATE api_exposure SET enabled = false, changed_by = 'operator:opr_ctl', changed_at = $1, reason_code = 'incident', updated_at = $1 WHERE group_name = 'mcp:buy_unit'",
        [T2],
      );
      const ev = await eventsOf(d, 'api_exposure', 'mcp:buy_unit');
      expect(ev).toHaveLength(before + 1);
      const last = ev.at(-1)!;
      expect(last).toMatchObject({
        event_type: 'api_exposure.updated',
        actor_kind: 'operator',
        actor_id: 'opr_ctl',
        channel: 'web',
        chain_key: 'plat',
      });
      expect(last.body.cols['enabled']).toEqual([true, false]);
      expect(last.body.cols['reason_code']).toEqual([null, 'incident']);
      expect(JSON.stringify(last)).not.toContain('operator:opr_ctl');
      expect(last.body.hashed['changed_by']![1]).toMatch(/^[0-9a-f]{64}$/);
      expect((await verifyTrace(d)).findings).toEqual([]);
    } finally {
      await d.close();
    }
  });
});

describe('restore', () => {
  it('exports and imports into a fresh database and keeps the exposure rows', async () => {
    const s = await freshDb();
    const t = await freshDb();
    try {
      const c = ctx({ channel: 'web', actor_kind: 'operator', actor_id: 'opr_ctl' });
      await as(s, c, clock).query(
        "UPDATE api_exposure SET enabled = false, changed_by = 'operator:opr_ctl', changed_at = $1, reason_code = 'maintenance', updated_at = $1 WHERE group_name = 'seller'",
        [T2],
      );
      const text = await exportSql(s, { utc: '2026-11-05T12:00:00Z' });
      expect(text).toContain('INSERT INTO "api_exposure"');
      await importSql(t, text);
      expect(await rows(t)).toEqual(await rows(s));
      expect((await rows(t)).find((x) => x.group_name === 'seller')!.enabled).toBe(false);
      expect((await verifyTrace(t)).findings).toEqual([]);
      // the delete guard is back on after the import
      await expect(
        t.query("DELETE FROM api_exposure WHERE group_name = 'orders'"),
      ).rejects.toThrow();
    } finally {
      await s.close();
      await t.close();
    }
  });
});
