// BR-2 / journal seed convention (consolidation section 2): migration 0027 adds rule_settings to the journal
// with names that carry its own number only. A fresh database migrates to head, a reset refills every
// tracked row, and the verifier reports nothing after seeded writes.
import { TRACKED_TABLES } from '@umsbx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './testing';
import { freshDb, seedWorld } from './trace-test-support';
import type { Db } from './trace-test-support';
import { traceInvariants, verifyTrace } from './trace-verify';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

const tracked = async (d: Db) =>
  (
    await d.query<{
      table_name: string;
      columns: string[];
      hashed_columns: string[];
      digest_columns: string[];
      time_column: string;
      chain_expr: string;
    }>('SELECT * FROM trace_tracked ORDER BY table_name')
  ).rows.map((r) => ({
    table: r.table_name,
    copied: r.columns,
    hashed: r.hashed_columns,
    digest: r.digest_columns,
    time: r.time_column,
    chain: r.chain_expr,
  }));
const golden = () =>
  [...TRACKED_TABLES]
    .sort((a, b) => (a.table < b.table ? -1 : 1))
    .map((t) => ({
      table: t.table,
      copied: [...t.copied],
      hashed: [...t.hashed],
      digest: [...t.digest],
      time: t.time,
      chain: t.chain,
    }));

describe('migration 0027 and the journal', () => {
  it('fresh migrate to head', async () => {
    const f = await db.query<{ proname: string }>(
      "SELECT proname FROM pg_proc WHERE proname LIKE 'trace_tracked_%' ORDER BY proname",
    );
    expect(f.rows.map((r) => r.proname)).toEqual(
      expect.arrayContaining([
        'trace_tracked_seed',
        'trace_tracked_reseed',
        'trace_tracked_seed_0027',
        'trace_tracked_reseed_0027',
      ]),
    );
    const trig = await db.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trace_tracked_reseed', 'trace_tracked_reseed_0027', 'trace_capture_rule_settings') ORDER BY tgname",
    );
    expect(trig.rows.map((r) => r.tgname)).toEqual([
      'trace_capture_rule_settings',
      'trace_tracked_reseed',
      'trace_tracked_reseed_0027',
    ]);
    expect(await tracked(db)).toEqual(golden());
  });

  it('reset refills every tracked row', async () => {
    const d = await freshDb();
    try {
      await resetDatabase(d);
      expect(await tracked(d)).toEqual(golden());
    } finally {
      await d.close();
    }
  });

  it('trace:verify ok, 0 unattributed', async () => {
    const d = await freshDb();
    try {
      await seedWorld(d);
      expect((await verifyTrace(d)).findings).toEqual([]);
      expect(await traceInvariants(d)).toEqual([]);
      const rule = await d.query("SELECT 1 FROM trace_events WHERE source_table = 'rule_settings'");
      expect(rule.rows).toHaveLength(1);
      const bare = await d.query("SELECT 1 FROM trace_events WHERE actor_kind = 'unattributed'");
      expect(bare.rows).toHaveLength(0);
    } finally {
      await d.close();
    }
  });
});
