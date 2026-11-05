// INT-TR0 / TR0.6: backfill. A database built to the previous migration, with rows in every tracked
// table, gets one system/backfill "<table>.imported" event per tracked row when the journal migration
// runs. A second call to trace_backfill() adds nothing.
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_ROOT, applyMigrations } from './migrate';
import { openDatabase } from './index';
import { traceInvariants, verifyTrace } from './trace-verify';
import {
  STEPS,
  T,
  allEvents,
  chainOf,
  clock,
  countEvents,
  ctx,
  as,
  eventsOf,
} from './trace-test-support';
import type { Db } from './trace-test-support';

const COMMON = join(MIGRATIONS_ROOT, 'common');
const JOURNAL = /^\d{4}_trace_journal\.sql$/;
// A migration that needs the journal (INT-AL 0025 alert_events) cannot be in the world that predates it.
const AFTER_JOURNAL = /^0025_alert_events\.sql$/;
let beforeDir: string;
let db: Db;
let rowsBefore: Record<string, string[]>;

// The id the journal uses as source_id: offers are keyed by id and version, two tables by another column.
const idCol = (table: string): string =>
  table === 'safety_switches'
    ? 'name'
    : table === 'access_windows'
      ? 'entitlement_id'
      : table === 'offers'
        ? "id || ':' || version"
        : 'id';

beforeAll(async () => {
  beforeDir = mkdtempSync(join(tmpdir(), 'umsbx-trace-before-'));
  for (const f of readdirSync(COMMON))
    if (!JOURNAL.test(f) && !AFTER_JOURNAL.test(f)) cpSync(join(COMMON, f), join(beforeDir, f));
  db = await openDatabase({ kind: 'pglite-memory' });
  await applyMigrations(db, { now: () => new Date(T) }, beforeDir);
  expect((await db.query("SELECT to_regclass('trace_events') AS t")).rows[0]).toEqual({ t: null });
  // The world as it stood before the journal: a plain database, no context. A table that came with a later
  // migration (alert_events) has no rows in that world.
  const present = [];
  for (const s of STEPS)
    if ((await db.query('SELECT to_regclass($1) AS t', [s.table])).rows[0]!['t'] !== null)
      present.push(s);
  for (const s of present) if (s.insert) await s.insert(db);
  for (const s of present) if (s.update) await db.query(s.update.sql, s.update.params);
  rowsBefore = {};
  for (const s of present) {
    const col = idCol(s.table);
    rowsBefore[s.table] = (
      await db.query<{ id: string }>(`SELECT ${col} AS id FROM ${s.table} ORDER BY ${col}`)
    ).rows.map((r) => r.id);
  }
  await applyMigrations(db, { now: () => new Date(T) }, COMMON);
});
afterAll(async () => {
  await db.close();
  rmSync(beforeDir, { recursive: true, force: true });
});

describe('the migration backfills what was already there', () => {
  it('writes one imported event per tracked row, as system on the backfill channel', async () => {
    const missing: string[] = [];
    const wrong: string[] = [];
    for (const [table, ids] of Object.entries(rowsBefore)) {
      for (const id of ids) {
        const ev = await eventsOf(db, table, id);
        if (ev.length !== 1) {
          missing.push(`${table} ${id}: ${ev.length}`);
          continue;
        }
        const e = ev[0]!;
        if (
          e.event_type !== `${table}.imported` ||
          e.actor_kind !== 'system' ||
          e.channel !== 'backfill' ||
          e.ctx_id !== null ||
          e.mfa !== false
        ) {
          wrong.push(`${table} ${id}: ${e.event_type} ${e.actor_kind} ${e.channel}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(wrong).toEqual([]);
  });

  it('the total is the number of tracked rows: no table is skipped, none is counted twice', async () => {
    const tracked = Object.values(rowsBefore).reduce((n, ids) => n + ids.length, 0);
    expect(await countEvents(db)).toBe(tracked);
    expect(tracked).toBeGreaterThan(30);
  });

  it('takes occurred_at from the row’s own time column, not from the migration clock', async () => {
    const [e] = await eventsOf(db, 'orders', 'ord_1');
    const row = (
      await db.query<{ t: string }>(
        "SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS t FROM orders WHERE id = 'ord_1'",
      )
    ).rows[0]!;
    expect(e!.occurred_at).toBe(row.t);
  });

  it('puts rows in id order within a chain and numbers each chain from 1', async () => {
    const rows = await chainOf(db, 'plat');
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    const orderRows = await chainOf(db, 'ord:ord_1');
    expect(orderRows.length).toBeGreaterThan(5);
    expect(orderRows[0]!.prev_hash).toBe('0'.repeat(64));
  });

  it('the imported event holds the current value of each copied column as [null, value]', async () => {
    const [e] = await eventsOf(db, 'orders', 'ord_1');
    expect(e!.body.op).toBe('imported');
    expect(e!.body.cols['status']![0]).toBeNull();
    const cur = (await db.query<{ status: string }>("SELECT status FROM orders WHERE id = 'ord_1'"))
      .rows[0]!;
    expect(e!.body.cols['status']![1]).toBe(cur.status);
  });

  it('INV-T2 is empty and verify passes, drift included', async () => {
    expect(await traceInvariants(db)).toEqual([]);
    expect((await verifyTrace(db)).findings).toEqual([]);
  });
});

describe('a second call adds nothing', () => {
  it('trace_backfill() returns 0 and the journal is unchanged', async () => {
    const before = await allEvents(db);
    const r = await db.query<{ n: number }>('SELECT trace_backfill()::int AS n');
    expect(r.rows[0]!.n).toBe(0);
    expect(await allEvents(db)).toEqual(before);
  });

  it('a row written after the migration is not backfilled again by a later call', async () => {
    await as(db, ctx(), clock).query(
      "UPDATE orders SET order_ref = 'REF-X', updated_at = '2026-11-04T11:00:00Z' WHERE id = 'ord_1'",
    );
    const before = await countEvents(db);
    await db.query('SELECT trace_backfill()');
    expect(await countEvents(db)).toBe(before);
    const ev = await eventsOf(db, 'orders', 'ord_1');
    expect(ev.map((e) => e.event_type)).toEqual(['orders.imported', 'orders.updated']);
    expect((await verifyTrace(db)).findings).toEqual([]);
  });

  it('a tracked row whose event was lost is journaled by a new call, and verify then passes', async () => {
    // A row inserted with its capture trigger off has no event: the next backfill picks it up.
    await db.exec('ALTER TABLE alerts DISABLE TRIGGER trace_capture_alerts');
    await db.query(
      `INSERT INTO alerts (id, kind, detail, created_at, updated_at) VALUES ('alr_gap', 'k', '{"reason":"gap"}', '${T}', '${T}')`,
    );
    await db.exec('ALTER TABLE alerts ENABLE TRIGGER trace_capture_alerts');
    expect((await verifyTrace(db)).findings.some((f) => f.detail.includes('alr_gap'))).toBe(true);
    const r = await db.query<{ n: number }>('SELECT trace_backfill()::int AS n');
    expect(r.rows[0]!.n).toBe(1);
    expect((await eventsOf(db, 'alerts', 'alr_gap'))[0]).toMatchObject({
      actor_kind: 'system',
      channel: 'backfill',
    });
    expect((await verifyTrace(db)).findings).toEqual([]);
  });
});
