// INT-CTL / 0026: the seed convention of the journal. 0023's trace_tracked_seed(), trace_tracked_reseed() and their
// trigger are untouched; 0026 adds trace_tracked_seed_0026() and trace_tracked_reseed_0026() for api_exposure only.
// A fresh database has every row, a reset refills every row, and the journal verifies with nothing bare.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRACKED_TABLES } from '@umsbx/contracts';
import { resetDatabase } from './testing';
import { traceInvariants, verifyTrace } from './trace-verify';
import { freshDb, seedWorld } from './trace-test-support';
import type { Db } from './trace-test-support';

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
    }>(
      'SELECT table_name, columns, hashed_columns, digest_columns, time_column, chain_expr FROM trace_tracked ORDER BY table_name',
    )
  ).rows;
const golden = () =>
  [...TRACKED_TABLES]
    .sort((a, b) => (a.table < b.table ? -1 : 1))
    .map((t) => ({
      table_name: t.table,
      columns: [...t.copied],
      hashed_columns: [...t.hashed],
      digest_columns: [...t.digest],
      time_column: t.time,
      chain_expr: t.chain,
    }));

describe('0026 journal seed convention', () => {
  it('fresh migrate to head', async () => {
    expect(await tracked(db)).toEqual(golden());
    const fns = (
      await db.query<{ proname: string }>(
        "SELECT proname FROM pg_proc WHERE proname LIKE 'trace_tracked_%seed%' ORDER BY proname",
      )
    ).rows.map((r) => r.proname);
    expect(fns).toEqual(
      expect.arrayContaining([
        'trace_tracked_reseed',
        'trace_tracked_reseed_0026',
        'trace_tracked_seed',
        'trace_tracked_seed_0026',
      ]),
    );
    const row = (await tracked(db)).find((r) => r.table_name === 'api_exposure')!;
    expect(row).toEqual({
      table_name: 'api_exposure',
      columns: ['enabled', 'changed_at', 'reason_code'],
      hashed_columns: ['changed_by'],
      digest_columns: [],
      time_column: 'changed_at',
      chain_expr: 'plat',
    });
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
      const bare = await d.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM trace_events WHERE actor_kind = 'unattributed'",
      );
      expect(bare.rows[0]!.n).toBe(0);
    } finally {
      await d.close();
    }
  });
});
