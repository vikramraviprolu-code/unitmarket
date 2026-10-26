// DP-2a (MVP-D): migration 0011 on a copy of an MVP-C-shaped database. The database is migrated to
// 0010 only and holds one order for each of the ten order statuses, each with its one provider order
// and its operations, written as MVP-C wrote them. Then 0011 runs. The overview's backfill mapping
// decides the state of each provider order; nothing is written from a clock; the constraints hold.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigrations, migrate, openDatabase } from '@umsbx/db';
import type { Database } from '@umsbx/contracts';

const T = '2026-10-21T10:00:00Z';
const T15 = '2026-10-21T10:15:00Z';
const clock = { now: () => new Date(T) };
const HASH = (n: number): string => n.toString(16).padStart(64, '0');
const common = new URL('../../../packages/db/migrations/common/', import.meta.url);

type Db = Database & { close(): Promise<void> };
const open: Db[] = [];
afterAll(async () => {
  for (const d of open) await d.close();
});

const STATUSES = [
  'created',
  'awaiting_buyer',
  'capture_requested',
  'capture_claimed',
  'unresolved',
  'paid',
  'paid_partial',
  'failed',
  'abandoned',
  'frozen',
] as const;
/** Overview section 3, backfill of existing rows. */
const EXPECTED_STATE: Record<(typeof STATUSES)[number], string> = {
  created: 'prepared',
  awaiting_buyer: 'awaiting_buyer',
  capture_requested: 'capture_requested',
  capture_claimed: 'capture_claimed',
  unresolved: 'unresolved',
  paid: 'captured',
  paid_partial: 'captured',
  failed: 'failed',
  abandoned: 'abandoned',
  frozen: 'frozen',
};

/** A database as the MVP-C disk is: migrated to 0010, ten single-publisher orders in every status. */
async function mvpCShaped(): Promise<{ db: Db; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'ums-mig11-'));
  for (const f of readdirSync(common).filter((n) => /^00(0[1-9]|10)_.+\.sql$/.test(n))) {
    writeFileSync(join(dir, f), readFileSync(new URL(f, common), 'utf8'));
  }
  const db = await openDatabase({ kind: 'pglite-memory' });
  open.push(db);
  expect((await applyMigrations(db, clock, dir)).at(-1)).toBe('0010_publisher_payee_shared');
  await db.query(
    `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, payee_verified_at, created_at, updated_at)
     VALUES ('pub_h', 'harbour-ledger', 'Harbour', 'US', 'SBXMOWNERBUSINESS', $1, $1, $1)`,
    [T],
  );
  await db.query(
    `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
     VALUES ('buy_1', 'B', 'sub1', 'US', $1, $1)`,
    [T],
  );
  for (const [k, status] of STATUSES.entries()) {
    const n = k + 1;
    await db.query(
      `INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, used_at, environment, created_at, updated_at)
       VALUES ($1, 'buy_1', '{"v":1}'::jsonb, $2, $3, $4, NULL, 'dryrun', $5, $5)`,
      [`apr_${n}`, HASH(n), `nonce${n}`, T15, T],
    );
    await db.query(
      `INSERT INTO orders (id, approval_id, buyer_id, content_hash, order_ref, expected, status, mismatch,
         corridor_id, currency, total_minor, environment, created_at, updated_at)
       VALUES ($1, $2, 'buy_1', $3, $4, '{}'::jsonb, $5, $6, 'us-usd', 'USD', 500, 'dryrun', $7, $7)`,
      [`ord_${n}`, `apr_${n}`, HASH(n), `ref_${n}`, status, status === 'frozen', T],
    );
    await db.query(
      `INSERT INTO provider_orders (id, order_id, provider_order_id, route, approve_url, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'single', NULL, 'APPROVED', $4, $4)`,
      [`pvo_${n}`, `ord_${n}`, status === 'created' ? null : `SBXPO${n}`, T],
    );
    await db.query(
      `INSERT INTO order_units (id, order_id, provider_order_ref, publisher_id, reference_id, payee_merchant_id,
         amount_minor, platform_fee_minor, capture_id, status, refunded_minor, created_at, updated_at)
       VALUES ($1, $2, $3, 'pub_h', $1, 'SBXMOWNERBUSINESS', 500, 0, NULL, 'expected', 0, $4, $4)`,
      [`unt_${n}`, `ord_${n}`, `pvo_${n}`, T],
    );
    for (const [kind, key] of [
      ['create', `umsC-ref_${n}`],
      ['capture', `umsK-ref_${n}`],
      ['readback', `umsB-ref_${n}`],
    ] as const) {
      await db.query(
        `INSERT INTO operations (id, order_id, unit_id, kind, state, attempt, request_id, lease_until, reconcile_until, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, 'unknown', 1, $4, NULL, $5, $6, $6)`,
        [`opr_${n}_${kind}`, `ord_${n}`, kind, key, T15, T],
      );
    }
  }
  // A refund request and its operations belong to a refund, not to a PayPal order.
  await db.query(
    `INSERT INTO operations (id, order_id, unit_id, kind, state, attempt, request_id, lease_until, reconcile_until, created_at, updated_at)
     VALUES ('opr_refund', 'ord_6', NULL, 'refund', 'unknown', 1, 'umsR-rfq_1', NULL, $1, $2, $2)`,
    [T15, T],
  );
  return { db, dir };
}

describe('migration 0011 on a copy of an MVP-C-shaped database (DP-2a)', () => {
  it('the ten status mappings, and every existing value kept', async () => {
    const { db, dir } = await mvpCShaped();
    try {
      const before = (await db.query('SELECT * FROM provider_orders ORDER BY id')).rows;
      expect(await migrate(db, clock)).toEqual(['0011_provider_order_state']);
      const after = await db.query<Record<string, unknown>>(
        `SELECT p.*, o.status AS order_status, o.order_ref FROM provider_orders p
           JOIN orders o ON o.id = p.order_id ORDER BY p.id`,
      );
      expect(after.rows).toHaveLength(10);
      for (const row of after.rows) {
        const status = row['order_status'] as (typeof STATUSES)[number];
        expect(row['state'], status).toBe(EXPECTED_STATE[status]);
        expect(row['position']).toBe(1);
        expect(row['po_ref']).toBe(row['order_ref']); // equals order_ref for single
        expect(row['publisher_id']).toBeNull();
        expect(row['first_approved_at']).toBeNull(); // no clock, nothing invented
        expect(row['route']).toBe('single');
      }
      // every old column is untouched
      for (const [i, old] of before.entries()) {
        const now = after.rows[i]!;
        for (const col of Object.keys(old as object)) {
          expect(now[col], col).toEqual((old as Record<string, unknown>)[col]);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('operations are backfilled: create, capture and readback point at their provider order; refund operations stay null', async () => {
    const { db, dir } = await mvpCShaped();
    try {
      await migrate(db, clock);
      const ops = await db.query<{ id: string; kind: string; provider_order_ref: string | null }>(
        'SELECT id, kind, provider_order_ref FROM operations ORDER BY id',
      );
      for (const o of ops.rows) {
        if (o.kind === 'refund') {
          expect(o.provider_order_ref).toBeNull();
        } else {
          expect(o.provider_order_ref, o.id).toBe(`pvo_${o.id.split('_')[1]}`);
        }
      }
      expect(ops.rows.filter((o) => o.provider_order_ref !== null)).toHaveLength(30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a legacy order with two single provider rows still migrates: positions 1 and 2, distinct po_refs', async () => {
    const { db, dir } = await mvpCShaped();
    try {
      await db.query(
        `INSERT INTO provider_orders (id, order_id, provider_order_id, route, approve_url, status, created_at, updated_at)
         VALUES ('pvo_2b', 'ord_2', 'SBXPO2B', 'single', NULL, 'APPROVED', $1, $1)`,
        [T],
      );
      await migrate(db, clock);
      const rows = await db.query<{ id: string; position: number; po_ref: string }>(
        "SELECT id, position, po_ref FROM provider_orders WHERE order_id = 'ord_2' ORDER BY position",
      );
      expect(rows.rows.map((r) => [r.id, r.position, r.po_ref])).toEqual([
        ['pvo_2', 1, 'ref_2'],
        ['pvo_2b', 2, 'ref_2-p2'],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('constraints hold after 0011', async () => {
    const { db, dir } = await mvpCShaped();
    try {
      await migrate(db, clock);
      const po = (over: Record<string, unknown>) => {
        const row = {
          id: 'pvo_x',
          order_id: 'ord_1',
          provider_order_id: null,
          route: 'per_publisher',
          approve_url: null,
          status: null,
          position: 2,
          po_ref: 'ref_1-p2',
          publisher_id: 'pub_h',
          state: 'prepared',
          created_at: T,
          updated_at: T,
          ...over,
        };
        const cols = Object.keys(row);
        return db.query(
          `INSERT INTO provider_orders (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          cols.map((c) => (row as Record<string, unknown>)[c]),
        );
      };
      await po({}); // a valid second provider order: per_publisher, with a publisher
      await expect(po({ id: 'pvo_y' })).rejects.toThrow(/duplicate key|unique/i); // (order_id, position), po_ref, (order_id, publisher_id)
      await expect(po({ id: 'pvo_y', position: 3 })).rejects.toThrow(/duplicate key|unique/i); // po_ref
      await expect(po({ id: 'pvo_y', position: 3, po_ref: 'ref_1-p3' })).rejects.toThrow(
        /duplicate key|unique/i,
      ); // (order_id, publisher_id)
      await db.query(
        `INSERT INTO publishers (id, slug, display_name, country, created_at, updated_at) VALUES ('pub_2', 'q', 'Q', 'US', $1, $1)`,
        [T],
      );
      // per_publisher needs a publisher
      await expect(
        po({ id: 'pvo_y', position: 3, po_ref: 'ref_1-p3', publisher_id: null }),
      ).rejects.toThrow();
      // single does not
      await po({
        id: 'pvo_s',
        order_id: 'ord_3',
        position: 2,
        po_ref: 'ref_3-p2',
        route: 'single',
        publisher_id: null,
      });
      // the state list
      await expect(
        po({ id: 'pvo_y', position: 3, po_ref: 'ref_1-p3', publisher_id: 'pub_2', state: 'done' }),
      ).rejects.toThrow();
      // all eleven states are accepted (single rows have no publisher, so nothing else collides)
      for (const [i, state] of [
        'prepared',
        'awaiting_buyer',
        'approved',
        'capture_requested',
        'capture_claimed',
        'unresolved',
        'captured',
        'declined',
        'frozen',
        'failed',
        'abandoned',
      ].entries()) {
        await po({
          id: `pvo_st${i}`,
          order_id: 'ord_4',
          position: 10 + i,
          po_ref: `r4-${state}`,
          route: 'single',
          publisher_id: null,
          state,
        });
      }
      // position, po_ref and state are required
      for (const col of ['position', 'po_ref', 'state']) {
        await expect(
          po({ id: 'pvo_n', position: 9, po_ref: 'ref_1-p9', publisher_id: 'pub_2', [col]: null }),
        ).rejects.toThrow(/null|not-null/i);
      }
      await expect(
        po({ id: 'pvo_n', position: 0, po_ref: 'ref_1-p0', publisher_id: 'pub_2' }),
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is forward-only: a second run is a no-op, there is no down step, no now() and no DEFAULT', async () => {
    const { db, dir } = await mvpCShaped();
    try {
      await migrate(db, clock);
      expect(await migrate(db, clock)).toEqual([]);
      const files = readdirSync(common);
      expect(files.filter((n) => /^0011_.+\.sql$/.test(n))).toEqual([
        '0011_provider_order_state.sql',
      ]);
      expect(files.filter((n) => /^0011_.+\.sql$/.test(n) && /down|rollback/i.test(n))).toEqual([]);
      const sql = readFileSync(new URL('0011_provider_order_state.sql', common), 'utf8').replace(
        /--.*$/gm,
        '',
      );
      expect(sql).not.toMatch(/\bnow\s*\(/i);
      expect(sql).not.toMatch(/current_timestamp|clock_timestamp|statement_timestamp/i);
      expect(sql).not.toMatch(/\bDEFAULT\b/i);
      // added nullable first, then NOT NULL after the backfill
      expect(sql.indexOf('UPDATE provider_orders')).toBeGreaterThan(-1);
      expect(sql.indexOf('UPDATE provider_orders')).toBeLessThan(sql.indexOf('SET NOT NULL'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
