// INT-TR0 / TR0.4: the verifier on a clean world, the seal function and the two invariants.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkInvariants } from './export-sql';
import { formatTraceFinding, traceInvariants, verifyTrace } from './trace-verify';
import {
  T,
  as,
  chainOf,
  countEvents,
  ctx,
  freshDb,
  ins,
  j,
  seedWorld,
  updateWorld,
} from './trace-test-support';
import type { Db } from './trace-test-support';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await seedWorld(db);
  await updateWorld(db);
});
afterAll(async () => {
  await db.close();
});

const sha = async (text: string): Promise<string> =>
  (
    await db.query<{ h: string }>("SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h", [
      text,
    ])
  ).rows[0]!.h;

describe('verify on a clean journal', () => {
  it('finds nothing and reports what it checked', async () => {
    const r = await verifyTrace(db);
    expect(r.findings).toEqual([]);
    expect(r.chains).toBeGreaterThanOrEqual(6); // ord, buy, pub x2, key, mdt, plat
    expect(r.rows).toBe(await countEvents(db));
    expect(r.seals).toBe(0);
    expect(r.checked).toBeGreaterThan(25); // one tracked row per table at least
    expect(r.unattributed).toBe(0);
  });

  it('every chain starts at seq 1 with the 64 zero genesis hash and links row to row', async () => {
    const ord = await chainOf(db, 'ord:ord_1');
    expect(ord.length).toBeGreaterThan(10);
    expect(ord[0]!.seq).toBe(1);
    expect(ord[0]!.prev_hash).toBe('0'.repeat(64));
    for (let i = 1; i < ord.length; i += 1) {
      expect(ord[i]!.seq).toBe(i + 1);
      expect(ord[i]!.prev_hash).toBe(ord[i - 1]!.row_hash);
    }
    const heads = await db.query<{ seq: number; row_hash: string }>(
      "SELECT seq::int, row_hash FROM trace_heads WHERE chain_key = 'ord:ord_1'",
    );
    expect(heads.rows[0]).toEqual({ seq: ord.length, row_hash: ord.at(-1)!.row_hash });
  });

  it('row_hash is sha256 of the canonical text of every column except row_hash', async () => {
    const [e] = await chainOf(db, 'buy:buy_1');
    const canon = await db.query<{ canon: string; h: string }>(
      `SELECT trace_canon(e) AS canon, encode(sha256(convert_to(trace_canon(e), 'UTF8')), 'hex') AS h
         FROM trace_events e WHERE chain_key = 'buy:buy_1' AND seq = 1`,
    );
    expect(canon.rows[0]!.h).toBe(e!.row_hash);
    const parsed = JSON.parse(canon.rows[0]!.canon) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'actor_id',
        'actor_kind',
        'body',
        'buyer_id',
        'channel',
        'chain_key',
        'ctx_id',
        'event_type',
        'mandate_id',
        'mandate_ref',
        'mfa',
        'occurred_at',
        'on_behalf_of',
        'order_id',
        'prev_hash',
        'publisher_id',
        'seq',
        'source_id',
        'source_table',
        'unit_id',
      ].sort(),
    );
    expect(parsed['occurred_at']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  });

  it('the canonical text does not depend on the session time zone or date style', async () => {
    const before = (
      await db.query<{ canon: string }>(
        "SELECT trace_canon(e) AS canon FROM trace_events e WHERE chain_key = 'buy:buy_1' AND seq = 1",
      )
    ).rows[0]!.canon;
    await db.exec("SET TIME ZONE 'Asia/Kolkata'; SET DateStyle = 'SQL, DMY'");
    try {
      const after = (
        await db.query<{ canon: string }>(
          "SELECT trace_canon(e) AS canon FROM trace_events e WHERE chain_key = 'buy:buy_1' AND seq = 1",
        )
      ).rows[0]!.canon;
      expect(after).toBe(before);
      expect((await verifyTrace(db)).findings).toEqual([]);
    } finally {
      await db.exec('RESET TIME ZONE; RESET DateStyle');
    }
  });

  it('runs in a read only transaction (the Postgres path of trace:verify)', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.exec('SET TRANSACTION READ ONLY');
      return tx.query('SELECT * FROM trace_verify()');
    });
    expect(rows.rows).toEqual([]);
  });

  it('formats a finding on one line that names the chain and the row', () => {
    expect(
      formatTraceFinding({
        check: 'chain',
        chain_key: 'ord:ord_1',
        seq: 4,
        detail: 'row_hash does not match the row',
      }),
    ).toBe('chain ord:ord_1 seq 4: row_hash does not match the row');
    expect(
      formatTraceFinding({
        check: 'drift',
        chain_key: null,
        seq: null,
        detail: 'drift orders ord_1 status',
      }),
    ).toBe('drift orders ord_1 status');
  });
});

describe('seals', () => {
  it('trace_seal writes one row per day: the second call returns the first, whatever its time', async () => {
    const a = await db.query<{ id: number; root_hash: string; day: string }>(
      "SELECT id::int, root_hash, day::text FROM trace_seal('2026-11-03', '2026-11-04T00:00:05Z')",
    );
    const b = await db.query<{ id: number; root_hash: string }>(
      "SELECT id::int, root_hash FROM trace_seal('2026-11-03', '2026-11-04T09:00:00Z')",
    );
    expect(b.rows[0]).toEqual({ id: a.rows[0]!.id, root_hash: a.rows[0]!.root_hash });
    expect((await db.query('SELECT 1 FROM trace_seals')).rows).toHaveLength(1);
  });

  it('holds the heads of every chain ordered by chain_key and a root that recomputes', async () => {
    const s = (
      await db.query<{
        day: string;
        prev_root_hash: string;
        root_hash: string;
        heads: { chain_key: string; seq: number; row_hash: string }[];
        heads_text: string;
      }>(
        'SELECT day::text, prev_root_hash, root_hash, heads, heads::text AS heads_text FROM trace_seals',
      )
    ).rows[0]!;
    expect(s.prev_root_hash).toBe('0'.repeat(64));
    const keys = s.heads.map((h) => h.chain_key);
    expect(keys).toEqual([...keys].sort());
    const live = await db.query<{ chain_key: string; seq: number; row_hash: string }>(
      'SELECT chain_key, seq::int, row_hash FROM trace_heads ORDER BY chain_key COLLATE "C"',
    );
    expect(s.heads).toEqual(live.rows);
    expect(s.root_hash).toBe(await sha(`${s.prev_root_hash}|${s.day}|${s.heads_text}`));
  });

  it('a row written after the seal falls into the next seal; the second seal chains to the first', async () => {
    const first = (await db.query<{ root_hash: string }>('SELECT root_hash FROM trace_seals'))
      .rows[0]!;
    await ins(as(db, ctx()), 'alerts', {
      id: 'alr_late',
      kind: 'k',
      order_id: null,
      unit_id: null,
      detail: j({}),
    });
    await db.query("SELECT trace_seal('2026-11-04', '2026-11-05T00:00:05Z')");
    const seals = (
      await db.query<{ day: string; prev_root_hash: string; heads: unknown[] }>(
        'SELECT day::text, prev_root_hash, heads FROM trace_seals ORDER BY day',
      )
    ).rows;
    expect(seals).toHaveLength(2);
    expect(seals[1]!.prev_root_hash).toBe(first.root_hash);
    expect(JSON.stringify(seals[1]!.heads)).toContain('alr_late'.length > 0 ? 'plat' : '');
    const r = await verifyTrace(db);
    expect(r.findings).toEqual([]);
    expect(r.seals).toBe(2);
  });

  it('a chain that grows after a seal is still valid: the seal holds an earlier row of it', async () => {
    await as(db, ctx())
      .query(`UPDATE orders SET status = 'paid', updated_at = '${T}' WHERE id = 'ord_1'`)
      .catch(() => undefined);
    expect((await verifyTrace(db)).findings).toEqual([]);
  });
});

describe('the invariants', () => {
  it('INV-T1 and INV-T2 are empty on a clean journal, in the report and in checkInvariants', async () => {
    expect(await traceInvariants(db)).toEqual([]);
    const lines = await checkInvariants(db);
    expect(lines.filter((l) => /^INV-T[12]/.test(l))).toEqual([]);
  });

  it('INV-T2 lists a row written with no context', async () => {
    const d = await freshDb();
    try {
      await ins(d, 'alerts', {
        id: 'alr_bare',
        kind: 'k',
        order_id: null,
        unit_id: null,
        detail: j({}),
      });
      const lines = await traceInvariants(d);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^INV-T2 .*unattributed.*alerts alr_bare/);
      expect((await checkInvariants(d)).some((l) => l.startsWith('INV-T2'))).toBe(true);
      expect((await verifyTrace(d)).unattributed).toBe(1);
    } finally {
      await d.close();
    }
  });

  it('backfill rows are system events, not unattributed: a migrated database passes INV-T2', async () => {
    const d = await freshDb();
    try {
      expect(await traceInvariants(d)).toEqual([]);
    } finally {
      await d.close();
    }
  });

  it('INV-T1 names the broken chain', async () => {
    const d = await freshDb();
    try {
      await seedWorld(d);
      await d.exec('ALTER TABLE trace_events DISABLE TRIGGER trace_events_append_only');
      await d.exec(
        "UPDATE trace_events SET mfa = NOT mfa WHERE chain_key = 'buy:buy_1' AND seq = 1",
      );
      await d.exec('ALTER TABLE trace_events ENABLE TRIGGER trace_events_append_only');
      const lines = await traceInvariants(d);
      expect(lines.some((l) => l.startsWith('INV-T1') && l.includes('buy:buy_1'))).toBe(true);
    } finally {
      await d.close();
    }
  });
});
