// TR-LINK / journal seed convention (consolidation section 2): migration 0031 adds publisher_paypal_links to the
// journal with names that carry its own number only. A fresh database migrates to head, a reset refills every
// tracked row, rows that exist before 0031 are backfilled, a direct SQL change is attributed, and a logical
// export loads back with the journal intact.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRACKED_TABLES } from '@umsbx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSql, importSql } from './export-sql';
import { applyMigrations, MIGRATIONS_ROOT } from './migrate';
import { openDatabase } from './pglite';
import { resetDatabase } from './testing';
import { traceInvariants, verifyTrace } from './trace-verify';
import { allEvents, as, clock, ctx, eventsOf, freshDb, ins, T, T2, T3 } from './trace-test-support';
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
const sha = async (d: Db, text: string): Promise<string> =>
  (
    await d.query<{ h: string }>("SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h", [
      text,
    ])
  ).rows[0]!.h;

const pub = (id: string) => ({
  id,
  slug: id.replace('_', '-'),
  display_name: `Pub ${id}`,
  country: 'US',
  paypal_merchant_id: null,
  payee_verified_at: null,
});
const link = (publisher_id: string, paypal_email: string) => ({
  publisher_id,
  paypal_email,
  state: 'requested',
  verified_by: null,
  verified_at: null,
});

describe('migration 0031 and the journal', () => {
  it('fresh migrate to head: own seed and reseed functions, own trigger, the row of the golden list', async () => {
    const f = await db.query<{ proname: string }>(
      "SELECT proname FROM pg_proc WHERE proname LIKE 'trace_tracked_%' ORDER BY proname",
    );
    expect(f.rows.map((r) => r.proname)).toEqual(
      expect.arrayContaining([
        'trace_tracked_seed',
        'trace_tracked_reseed',
        'trace_tracked_seed_0031',
        'trace_tracked_reseed_0031',
      ]),
    );
    const trig = await db.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trace_tracked_reseed', 'trace_tracked_reseed_0031', 'trace_capture_publisher_paypal_links') ORDER BY tgname",
    );
    expect(trig.rows.map((r) => r.tgname)).toEqual([
      'trace_capture_publisher_paypal_links',
      'trace_tracked_reseed',
      'trace_tracked_reseed_0031',
    ]);
    expect(await tracked(db)).toEqual(golden());
    expect((await tracked(db)).find((r) => r.table_name === 'publisher_paypal_links')).toEqual({
      table_name: 'publisher_paypal_links',
      columns: ['state', 'verified_by', 'verified_at'],
      hashed_columns: ['paypal_email'],
      digest_columns: [],
      time_column: 'updated_at',
      chain_expr: 'pub:publisher_id',
    });
  });

  it('leaves 0023’s seed function, reseed function and trigger alone', async () => {
    const sql = readFileSync(
      new URL('../migrations/common/0031_publisher_paypal_link_journal.sql', import.meta.url),
      'utf8',
    ).replace(/--.*$/gm, '');
    expect(sql).not.toMatch(
      /ALTER FUNCTION|DROP FUNCTION|CREATE OR REPLACE FUNCTION trace_tracked_(seed|reseed)\(/i,
    );
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

  it('puts the link event on the chain of its publisher and keeps the other chains as they were', async () => {
    const d = await freshDb();
    try {
      const t = as(d, ctx());
      await ins(t, 'publishers', pub('pub_a'));
      await ins(t, 'publishers', pub('pub_b'));
      await ins(t, 'publisher_paypal_links', link('pub_a', 'a@example.com'));
      await ins(t, 'publisher_paypal_links', link('pub_b', 'b@example.com'));
      const a = await eventsOf(d, 'publisher_paypal_links', 'pub_a');
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({
        chain_key: 'pub:pub_a',
        publisher_id: 'pub_a',
        order_id: null,
        buyer_id: null,
      });
      const chain = (
        await d.query<{ source_table: string; seq: number }>(
          "SELECT source_table, seq::int AS seq FROM trace_events WHERE chain_key = 'pub:pub_a' ORDER BY seq",
        )
      ).rows;
      expect(chain.map((r) => r.source_table)).toEqual(['publishers', 'publisher_paypal_links']);
      expect(chain.map((r) => r.seq)).toEqual([1, 2]);
      expect((await verifyTrace(d)).findings).toEqual([]);
    } finally {
      await d.close();
    }
  });
});

describe('a direct SQL change of the stored address', () => {
  it('is journaled with the actor, channel, time and mfa of the context, and only the hashes of the address', async () => {
    const d = await freshDb();
    try {
      await ins(as(d, ctx()), 'publishers', pub('pub_a'));
      await ins(
        as(d, ctx({ actor_kind: 'publisher', actor_id: 'pub_a', mfa: false })),
        'publisher_paypal_links',
        link('pub_a', 'old@example.com'),
      );
      const c = ctx({
        channel: 'cli',
        actor_kind: 'operator',
        actor_id: 'opr_sql',
        mfa: true,
        at: T3,
      });
      await as(d, c, clock).query(
        `UPDATE publisher_paypal_links SET paypal_email = 'new@example.com', state = 'verified', verified_by = 'opr_sql', verified_at = '${T2}', updated_at = '${T2}' WHERE publisher_id = 'pub_a'`,
      );
      const ev = await eventsOf(d, 'publisher_paypal_links', 'pub_a');
      expect(ev).toHaveLength(2);
      const e = ev[1]!;
      expect(e).toMatchObject({
        actor_kind: 'operator',
        actor_id: 'opr_sql',
        channel: 'cli',
        mfa: true,
        ctx_id: c.id,
        occurred_at: '2026-11-04T11:00:00Z',
      });
      expect(e.body.hashed['paypal_email']).toEqual([
        await sha(d, 'old@example.com'),
        await sha(d, 'new@example.com'),
      ]);
      expect(e.body.cols['state']).toEqual(['requested', 'verified']);
      expect(JSON.stringify(await allEvents(d))).not.toContain('example.com');
      expect((await verifyTrace(d)).findings).toEqual([]);
    } finally {
      await d.close();
    }
  });

  it('is journaled even when the writer does not touch updated_at, and with no context it is unattributed', async () => {
    const d = await freshDb();
    try {
      await ins(as(d, ctx()), 'publishers', pub('pub_a'));
      await ins(as(d, ctx()), 'publisher_paypal_links', link('pub_a', 'old@example.com'));
      await as(d, ctx({ at: T3 }), clock).query(
        "UPDATE publisher_paypal_links SET paypal_email = 'mid@example.com' WHERE publisher_id = 'pub_a'",
      );
      // No context at all: the trigger still writes the event, as unattributed.
      await d.query(
        "UPDATE publisher_paypal_links SET paypal_email = 'bare@example.com' WHERE publisher_id = 'pub_a'",
      );
      const ev = await eventsOf(d, 'publisher_paypal_links', 'pub_a');
      expect(ev.map((e) => e.body.n)).toEqual([1, 2, 3]);
      expect(ev[1]).toMatchObject({ actor_kind: 'operator', channel: 'web' });
      expect(ev[2]).toMatchObject({ actor_kind: 'unattributed', channel: null });
      expect(ev[2]!.body.hashed['paypal_email']![1]).toBe(await sha(d, 'bare@example.com'));
      expect((await verifyTrace(d)).findings).toEqual([]);
      const inv = await traceInvariants(d);
      expect(inv.some((l) => l.startsWith('INV-T1'))).toBe(false);
      expect(inv.some((l) => l.startsWith('INV-T2'))).toBe(true);
    } finally {
      await d.close();
    }
  });
});

describe('rows that exist before 0031', () => {
  it('are backfilled once, as system on the backfill channel, with the address only as a hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'umsbx-0031-before-'));
    const common = join(MIGRATIONS_ROOT, 'common');
    const d = await openDatabase({ kind: 'pglite-memory' });
    try {
      for (const f of readdirSync(common).filter((x) => x < '0031'))
        cpSync(join(common, f), join(dir, f));
      await applyMigrations(d, { now: () => new Date(T) }, dir);
      expect(
        (await d.query("SELECT to_regclass('publisher_paypal_links') AS t")).rows[0],
      ).not.toEqual({ t: null });
      expect((await d.query("SELECT to_regclass('trace_events') AS t")).rows[0]).not.toEqual({
        t: null,
      });
      // Written before the migration: a requested link and a verified one, no context.
      await ins(d, 'publishers', pub('pub_a'));
      await ins(d, 'publishers', pub('pub_b'));
      await ins(d, 'publisher_paypal_links', link('pub_a', 'a@example.com'));
      await ins(d, 'publisher_paypal_links', {
        ...link('pub_b', 'b@example.com'),
        state: 'verified',
        verified_by: 'opr_old',
        verified_at: T2,
        updated_at: T2,
      });
      const before = (
        await d.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM trace_events WHERE source_table = 'publisher_paypal_links'",
        )
      ).rows[0]!.n;
      expect(before).toBe(0);
      await applyMigrations(d, { now: () => new Date(T) }, common);
      for (const [id, email, state] of [
        ['pub_a', 'a@example.com', 'requested'],
        ['pub_b', 'b@example.com', 'verified'],
      ] as const) {
        const ev = await eventsOf(d, 'publisher_paypal_links', id);
        expect(ev, id).toHaveLength(1);
        expect(ev[0]).toMatchObject({
          event_type: 'publisher_paypal_links.imported',
          actor_kind: 'system',
          channel: 'backfill',
          chain_key: `pub:${id}`,
          publisher_id: id,
          ctx_id: null,
          mfa: false,
        });
        expect(ev[0]!.body.hashed['paypal_email']).toEqual([null, await sha(d, email)]);
        expect(ev[0]!.body.cols['state']).toEqual([null, state]);
      }
      expect((await eventsOf(d, 'publisher_paypal_links', 'pub_b'))[0]!.occurred_at).toBe(
        '2026-11-04T11:00:00Z',
      );
      expect(JSON.stringify(await allEvents(d))).not.toContain('example.com');
      expect((await verifyTrace(d)).findings).toEqual([]);
      // A second run adds nothing.
      const again = await d.query<{ n: number }>('SELECT trace_backfill() AS n');
      expect(again.rows[0]!.n).toBe(0);
    } finally {
      await d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('export and import (restore mode)', () => {
  it('keeps the link events as they were, journals nothing while it loads, and the journal is live again after', async () => {
    const s = await freshDb();
    const target = await freshDb();
    try {
      const traced = (c = ctx()) => as(s, c, clock);
      await ins(traced(), 'publishers', pub('pub_a'));
      await ins(
        traced(ctx({ actor_kind: 'publisher', actor_id: 'pub_a', mfa: false })),
        'publisher_paypal_links',
        link('pub_a', 'one@example.com'),
      );
      await traced(ctx({ actor_kind: 'operator', actor_id: 'opr_x', mfa: true })).query(
        `UPDATE publisher_paypal_links SET state = 'verified', verified_by = 'opr_x', verified_at = '${T2}', updated_at = '${T2}' WHERE publisher_id = 'pub_a'`,
      );
      await traced(ctx({ actor_kind: 'publisher', actor_id: 'pub_a', mfa: false })).query(
        `UPDATE publisher_paypal_links SET paypal_email = 'two@example.com', state = 'requested', verified_by = NULL, verified_at = NULL, updated_at = '${T3}' WHERE publisher_id = 'pub_a'`,
      );
      const text = await exportSql(s, { utc: '2026-11-04T12:00:00Z' });
      expect(text).toContain('INSERT INTO "publisher_paypal_links"');
      await importSql(target, text);
      const a = await eventsOf(s, 'publisher_paypal_links', 'pub_a');
      expect(a).toHaveLength(3);
      expect(await eventsOf(target, 'publisher_paypal_links', 'pub_a')).toEqual(a);
      expect(await allEvents(target)).toEqual(await allEvents(s));
      expect((await verifyTrace(target)).findings).toEqual([]);
      const row = (
        await target.query(
          'SELECT paypal_email, state FROM publisher_paypal_links WHERE publisher_id = $1',
          ['pub_a'],
        )
      ).rows[0];
      expect(row).toEqual({ paypal_email: 'two@example.com', state: 'requested' });
      // Live again: the next change lands at the next seq of the publisher chain.
      const last = (
        await target.query<{ seq: number }>(
          "SELECT seq::int FROM trace_heads WHERE chain_key = 'pub:pub_a'",
        )
      ).rows[0]!.seq;
      await as(target, ctx(), clock).query(
        "UPDATE publisher_paypal_links SET paypal_email = 'three@example.com', updated_at = '2026-11-04T13:00:00Z' WHERE publisher_id = 'pub_a'",
      );
      const ev = await eventsOf(target, 'publisher_paypal_links', 'pub_a');
      expect(ev).toHaveLength(4);
      expect(ev[3]!.seq).toBe(last + 1);
      expect((await verifyTrace(target)).findings).toEqual([]);
    } finally {
      await s.close();
      await target.close();
    }
  });
});
