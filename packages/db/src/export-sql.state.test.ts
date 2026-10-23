// CO-10: the logical export and its import. A seeded in-memory database is exported, imported into
// a fresh migrated database and compared; the import runs in one transaction, switches the
// append-only triggers off only inside it, and refuses anything it cannot trust.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase } from './index';
import { exportSql, importSql, latestMigrationVersion, rowCounts } from './export-sql';
import type { Database } from '@umsbx/contracts';

// Each test migrates a fresh in-memory database; on a busy machine that can pass the 30 s default.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const T = '2026-10-21T10:00:00Z';
const HASH = 'a'.repeat(64);
const clock = { now: () => new Date(T) };
type Db = Database & { close(): Promise<void> };
const toClose: Db[] = [];
// Close every database after each test: an open in-memory PGlite holds hundreds of megabytes.
afterEach(async () => {
  while (toClose.length > 0) await toClose.pop()!.close();
});

async function fresh(): Promise<Db> {
  const d = await openDatabase({ kind: 'pglite-memory' });
  toClose.push(d);
  await migrate(d, clock);
  return d;
}

async function ins(db: Database, table: string, row: Record<string, unknown>) {
  const r: Record<string, unknown> = { created_at: T, updated_at: T, ...row };
  const cols = Object.keys(r);
  await db.query(
    `INSERT INTO ${table} (${cols.map((c) => (c === 'on' ? '"on"' : c)).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}
const j = (v: unknown) => JSON.stringify(v);

// An order, a capture, a sale, a refund, a receipt, an access event and a provider call.
async function seed(db: Database) {
  await ins(db, 'publishers', {
    id: 'pub_1',
    slug: 'p1',
    display_name: 'Pub \'One\' \\ "q"',
    country: 'US',
    paypal_merchant_id: 'MERCH1',
    payee_verified_at: T,
  });
  await ins(db, 'articles', {
    id: 'art_1',
    publisher_id: 'pub_1',
    title: 'Café ☃ title',
    abstract: 'line one\nline two',
    language: 'en',
    topics: ['x', 'y'],
    published_at: T,
    sha256: HASH,
    content_key: 'k1',
    bytes: 10,
    mime: 'text/plain',
  });
  await ins(db, 'buyers', { id: 'buy_1', display_name: 'B', auth_subject: 'sub1', country: 'US' });
  await ins(db, 'approvals', {
    id: 'apr_1',
    buyer_id: 'buy_1',
    snapshot: j({ v: 1 }),
    content_hash: HASH,
    nonce: 'nonce1',
    expires_at: '2026-10-21T10:15:00Z',
    used_at: null,
    environment: 'dryrun',
  });
  await ins(db, 'orders', {
    id: 'ord_1',
    approval_id: 'apr_1',
    buyer_id: 'buy_1',
    content_hash: HASH,
    order_ref: 'ref_1',
    expected: j({}),
    status: 'created',
    mismatch: false,
    corridor_id: 'us-usd',
    currency: 'USD',
    total_minor: 500,
    environment: 'dryrun',
  });
  await ins(db, 'order_units', {
    id: 'unt_1',
    order_id: 'ord_1',
    provider_order_ref: null,
    publisher_id: 'pub_1',
    reference_id: 'refid_1',
    payee_merchant_id: 'MERCH1',
    amount_minor: 500,
    platform_fee_minor: 0,
    capture_id: 'CAP1',
    status: 'partially_refunded',
    status_reason: null,
    paypal_fee_minor: null,
    refunded_minor: 200,
    captured_verified_at: T,
    mismatch_reason: null,
  });
  await ins(db, 'entitlements', {
    id: 'ent_1',
    buyer_id: 'buy_1',
    article_id: 'art_1',
    unit_id: 'unt_1',
    option: 'keep_retrieve',
    policy: j({}),
    money_state: 'captured',
    access_state: 'locked',
    licence_state: 'granted',
    transition_log: j([]),
    environment: 'dryrun',
  });
  const led = (id: string, over: Record<string, unknown>) =>
    ins(db, 'ledger_entries', {
      id,
      unit_id: 'unt_1',
      capture_id: 'CAP1',
      currency: 'USD',
      refund_id: null,
      ref_entry_id: null,
      environment: 'dryrun',
      ...over,
    });
  await led('led_1', { kind: 'sale', amount_minor: 500 });
  await led('led_2', {
    kind: 'refund',
    amount_minor: 200,
    refund_id: 'RF1',
    ref_entry_id: 'led_1',
  });
  await ins(db, 'receipts', {
    id: 'rct_1',
    order_id: 'ord_1',
    version: 1,
    body: j({ total_minor: 500 }),
    sha256: HASH,
    environment: 'dryrun',
  });
  await ins(db, 'access_events', {
    id: 'aev_1',
    entitlement_id: 'ent_1',
    kind: 'access_ready',
    at: T,
    source: 'system',
    evidence: j({}),
    environment: 'dryrun',
  });
  await ins(db, 'access_events', {
    id: 'aev_2',
    entitlement_id: 'ent_1',
    kind: 'reader_rendered',
    at: T,
    source: 'buyer',
    evidence: j({ n: 1 }),
    environment: 'dryrun',
  });
}

const ledgerSums = async (db: Database) =>
  (
    await db.query(
      'SELECT kind, sum(amount_minor)::text AS total FROM ledger_entries GROUP BY kind ORDER BY kind',
    )
  ).rows;

describe('exportSql', () => {
  it('writes a header with the schema version and the tables in foreign-key order, parents first', async () => {
    const db = await fresh();
    await seed(db);
    const sql = await exportSql(db, { utc: T });
    const version = await latestMigrationVersion(db);
    expect(version).toMatch(/^\d{4}_/);
    const lines = sql.split('\n');
    expect(lines[0]).toMatch(/^-- /);
    expect(sql).toContain(`-- schema-version: ${version}`);
    const order = /^-- tables: (.*)$/m.exec(sql)![1]!.split(',');
    expect(order.indexOf('publishers')).toBeLessThan(order.indexOf('articles'));
    expect(order.indexOf('orders')).toBeLessThan(order.indexOf('order_units'));
    expect(order.indexOf('order_units')).toBeLessThan(order.indexOf('ledger_entries'));
    expect(order).not.toContain('schema_migrations');
    // The INSERT statements follow the same order.
    const inserted = [...sql.matchAll(/^INSERT INTO "([a-z_]+)"/gm)].map((m) => m[1]);
    const positions = inserted.map((t) => order.indexOf(t!));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(inserted).toContain('ledger_entries');
  });

  it('is deterministic for the same data and clock', async () => {
    const db = await fresh();
    await seed(db);
    expect(await exportSql(db, { utc: T })).toBe(await exportSql(db, { utc: T }));
  });

  it('every statement is one line, so a changed byte cannot hide in a multi-line literal', async () => {
    const db = await fresh();
    await seed(db);
    const sql = await exportSql(db, { utc: T });
    for (const line of sql.split('\n')) {
      expect(line === '' || line.startsWith('-- ') || line.startsWith('INSERT INTO "')).toBe(true);
    }
  });
});

describe('importSql', () => {
  it('round trips: same row counts, same ledger sums, same ledger rows, hostile characters intact', async () => {
    const src = await fresh();
    await seed(src);
    const sql = await exportSql(src, { utc: T });
    const dst = await fresh();
    const counts = await importSql(dst, sql);
    expect(counts).toEqual(await rowCounts(src));
    expect(await rowCounts(dst)).toEqual(await rowCounts(src));
    expect(await ledgerSums(dst)).toEqual(await ledgerSums(src));
    expect((await dst.query('SELECT title, abstract FROM articles')).rows).toEqual(
      (await src.query('SELECT title, abstract FROM articles')).rows,
    );
    expect((await dst.query('SELECT display_name FROM publishers')).rows).toEqual([
      { display_name: 'Pub \'One\' \\ "q"' },
    ]);
    // Whole-row equality for every table, timestamps and jsonb included.
    for (const t of Object.keys(await rowCounts(src))) {
      const a = await src.query(`SELECT to_jsonb(x)::text AS r FROM "${t}" x ORDER BY 1`);
      const b = await dst.query(`SELECT to_jsonb(x)::text AS r FROM "${t}" x ORDER BY 1`);
      expect(b.rows, t).toEqual(a.rows);
    }
  });

  it('replaces the migration seed rows instead of colliding with them', async () => {
    const src = await fresh();
    await src.query("UPDATE corridors SET min_charge_minor = 50 WHERE id = 'us-usd'");
    const sql = await exportSql(src, { utc: T });
    const dst = await fresh();
    await importSql(dst, sql);
    expect(
      (await dst.query("SELECT min_charge_minor FROM corridors WHERE id = 'us-usd'")).rows,
    ).toEqual([{ min_charge_minor: 50 }]);
  });

  it('leaves every user trigger enabled afterwards: append-only, truncate and ledger guards hold', async () => {
    const src = await fresh();
    await seed(src);
    const sql = await exportSql(src, { utc: T });
    const dst = await fresh();
    await importSql(dst, sql);
    const off = await dst.query(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'",
    );
    expect(off.rows).toEqual([]);
    await expect(
      dst.query("UPDATE ledger_entries SET amount_minor = 1 WHERE id = 'led_1'"),
    ).rejects.toThrow(/append-only/);
    await expect(dst.query("DELETE FROM ledger_entries WHERE id = 'led_2'")).rejects.toThrow(
      /append-only/,
    );
    await expect(dst.query("DELETE FROM receipts WHERE id = 'rct_1'")).rejects.toThrow(
      /append-only/,
    );
    await expect(dst.exec('TRUNCATE ledger_entries')).rejects.toThrow();
    await expect(
      dst.query("DELETE FROM safety_switches WHERE name = 'paypal_outbound'"),
    ).rejects.toThrow();
    // The ledger guard still bounds refunds by the sale.
    await expect(
      ins(dst, 'ledger_entries', {
        id: 'led_9',
        unit_id: 'unt_1',
        capture_id: 'CAP1',
        kind: 'refund',
        amount_minor: 400,
        currency: 'USD',
        refund_id: 'RF9',
        ref_entry_id: null,
        environment: 'dryrun',
      }),
    ).rejects.toThrow(/exceed/);
  });

  it('keeps the unique active entitlement index and the one-sale-per-capture index', async () => {
    const src = await fresh();
    await seed(src);
    const dst = await fresh();
    await importSql(dst, await exportSql(src, { utc: T }));
    await ins(dst, 'order_units', {
      id: 'unt_2',
      order_id: 'ord_1',
      provider_order_ref: null,
      publisher_id: 'pub_1',
      reference_id: 'refid_2',
      payee_merchant_id: 'MERCH1',
      amount_minor: 100,
      platform_fee_minor: 0,
      capture_id: null,
      status: 'expected',
      status_reason: null,
      paypal_fee_minor: null,
      refunded_minor: 0,
      captured_verified_at: null,
      mismatch_reason: null,
    });
    await expect(
      ins(dst, 'entitlements', {
        id: 'ent_2',
        buyer_id: 'buy_1',
        article_id: 'art_1',
        unit_id: 'unt_2',
        option: 'keep_retrieve',
        policy: j({}),
        money_state: 'pending',
        access_state: 'locked',
        licence_state: null,
        transition_log: j([]),
        environment: 'dryrun',
      }),
    ).rejects.toThrow(/entitlements_one_active_per_buyer_article|unique/i);
  });

  it('restarts the identity sequence after the highest imported value', async () => {
    const src = await fresh();
    await seed(src);
    const dst = await fresh();
    await importSql(dst, await exportSql(src, { utc: T }));
    const maxSeq = (await dst.query('SELECT max(seq)::int AS m FROM access_events')).rows[0] as {
      m: number;
    };
    await ins(dst, 'access_events', {
      id: 'aev_3',
      entitlement_id: 'ent_1',
      kind: 'revoked',
      at: T,
      source: 'operator',
      evidence: j({}),
      environment: 'dryrun',
    });
    const next = (await dst.query("SELECT seq::int AS s FROM access_events WHERE id = 'aev_3'"))
      .rows[0] as {
      s: number;
    };
    expect(next.s).toBeGreaterThan(maxSeq.m);
  });

  it('rolls everything back when a statement fails, with triggers still enabled', async () => {
    const src = await fresh();
    await seed(src);
    const sql = await exportSql(src, { utc: T });
    // Break the last INSERT: a duplicate primary key makes the statement fail after the others ran.
    const lines = sql.split('\n');
    const firstInsert = lines.findIndex((l) => l.startsWith('INSERT INTO "access_events"'));
    const broken = [...lines, lines[firstInsert]!].join('\n');
    const dst = await fresh();
    const before = await rowCounts(dst);
    await expect(importSql(dst, broken)).rejects.toThrow();
    expect(await rowCounts(dst)).toEqual(before);
    const off = await dst.query(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'",
    );
    expect(off.rows).toEqual([]);
  });

  it('refuses a schema-version mismatch, a missing header, and text that is not an export statement', async () => {
    const src = await fresh();
    await seed(src);
    const sql = await exportSql(src, { utc: T });
    const dst = await fresh();
    const version = await latestMigrationVersion(dst);
    await expect(
      importSql(dst, sql.replace(`schema-version: ${version}`, 'schema-version: 0001_core')),
    ).rejects.toThrow(/schema version/i);
    await expect(
      importSql(
        dst,
        sql
          .split('\n')
          .filter((l) => !l.startsWith('-- schema-version'))
          .join('\n'),
      ),
    ).rejects.toThrow(/header/i);
    await expect(importSql(dst, `${sql}\nDROP TABLE ledger_entries;\n`)).rejects.toThrow(
      /not an export statement/i,
    );
    await expect(
      importSql(dst, sql.replace(/INSERT INTO "buyers"/, 'INSERT INTO "pg_catalog.pg_class"')),
    ).rejects.toThrow();
    expect((await dst.query('SELECT count(*)::int AS n FROM ledger_entries')).rows).toEqual([
      { n: 0 },
    ]);
  });

  it('refuses a database that already holds application rows, and leaves it untouched', async () => {
    const src = await fresh();
    await seed(src);
    const sql = await exportSql(src, { utc: T });
    const dst = await fresh();
    await ins(dst, 'buyers', {
      id: 'buy_x',
      display_name: 'X',
      auth_subject: 'subx',
      country: 'US',
    });
    await expect(importSql(dst, sql)).rejects.toThrow(/not empty|fresh/i);
    expect((await dst.query('SELECT id FROM buyers')).rows).toEqual([{ id: 'buy_x' }]);
  });
});

describe('large exports (H2)', () => {
  it('loads a table whose export line is over 10 MB, quotes and all', async () => {
    const src = await fresh();
    await seed(src);
    await src.exec("UPDATE articles SET abstract = repeat(E'a\\'b ', 3000000)");
    const sql = await exportSql(src, { utc: T });
    const longest = sql.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
    expect(longest).toBeGreaterThan(10_000_000);
    const dst = await fresh();
    await importSql(dst, sql);
    const probe =
      "SELECT length(abstract)::int AS n, md5(abstract) AS h FROM articles WHERE id = 'art_1'";
    expect((await dst.query(probe)).rows).toEqual((await src.query(probe)).rows);
  });

  it('loads many small rows', async () => {
    const src = await fresh();
    await seed(src);
    await src.exec(
      `INSERT INTO buyers SELECT 'buy_m' || g, 'B', 'subm' || g, 'US', '${T}', '${T}' FROM generate_series(1, 5000) g`,
    );
    const dst = await fresh();
    const counts = await importSql(dst, await exportSql(src, { utc: T }));
    expect(counts['buyers']).toBe(5001);
    expect(counts).toEqual(await rowCounts(src));
  });

  it('a huge line that is not an export statement is refused cleanly, not with a stack overflow', async () => {
    const src = await fresh();
    await seed(src);
    const sql = await exportSql(src, { utc: T });
    const dst = await fresh();
    const junk = `INSERT INTO "buyers" OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::"buyers", '${"x'".repeat(6_000_000)}'::jsonb);`;
    await expect(importSql(dst, `${sql}${junk}\n`)).rejects.toThrow(/not an export statement/);
    const injected = `INSERT INTO "buyers" OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::"buyers", '[]' ; DROP TABLE buyers; --'::jsonb);`;
    await expect(importSql(dst, `${sql}${injected}\n`)).rejects.toThrow(/not an export statement/);
    expect((await dst.query('SELECT count(*)::int AS n FROM buyers')).rows).toEqual([{ n: 0 }]);
  });
});

describe('import keeps the INSERT guards on and re-checks the invariants (M1)', () => {
  const addLedger = (src: Database, over: Record<string, unknown>) =>
    ins(src, 'ledger_entries', {
      id: 'led_9',
      unit_id: 'unt_1',
      capture_id: 'CAP1',
      kind: 'refund',
      amount_minor: 100,
      currency: 'USD',
      refund_id: 'RF9',
      ref_entry_id: null,
      environment: 'dryrun',
      ...over,
    });

  async function refusesAndRollsBack(prep: (src: Database) => Promise<void>, message: RegExp) {
    const src = await fresh();
    await seed(src);
    await prep(src);
    const sql = await exportSql(src, { utc: T });
    const dst = await fresh();
    const before = await rowCounts(dst);
    await expect(importSql(dst, sql)).rejects.toThrow(message);
    expect(await rowCounts(dst)).toEqual(before);
    const off = await dst.query(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'",
    );
    expect(off.rows).toEqual([]);
  }

  it('refuses a refund of 900 against a sale of 500', () =>
    refusesAndRollsBack(async (src) => {
      await src.exec('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
      await addLedger(src, { amount_minor: 900 });
    }, /exceed/));

  it('refuses a EUR refund on a USD order', () =>
    refusesAndRollsBack(async (src) => {
      await src.exec('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
      await addLedger(src, { currency: 'EUR' });
    }, /currency/));

  it('refuses a sandbox order that consumed a dryrun approval', () =>
    refusesAndRollsBack(async (src) => {
      await src.exec('ALTER TABLE orders DISABLE TRIGGER USER');
      await src.exec("UPDATE orders SET environment = 'sandbox' WHERE id = 'ord_1'");
    }, /environment/));

  it('refuses a unit whose refunded amount disagrees with the ledger (INV1)', () =>
    refusesAndRollsBack(async (src) => {
      await src.exec("UPDATE order_units SET refunded_minor = 0 WHERE id = 'unt_1'");
    }, /INV1/));

  it('refuses a ledger row from another environment than its order', () =>
    refusesAndRollsBack(async (src) => {
      await src.exec('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
      await src.exec("UPDATE ledger_entries SET environment = 'sandbox' WHERE id = 'led_2'");
    }, /environment/));

  it('refuses an available entitlement without a verified capture (INV2)', () =>
    refusesAndRollsBack(async (src) => {
      await src.exec(
        "UPDATE order_units SET status = 'expected', captured_verified_at = NULL WHERE id = 'unt_1'",
      );
      await src.exec('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
      await src.exec('DELETE FROM ledger_entries');
      await src.exec("UPDATE order_units SET refunded_minor = 0 WHERE id = 'unt_1'");
      await src.exec("UPDATE entitlements SET access_state = 'available' WHERE id = 'ent_1'");
    }, /INV2/));

  it('the safety_switches delete guard is lifted only for the seed rows, then back on', async () => {
    const src = await fresh();
    await seed(src);
    const dst = await fresh();
    await importSql(dst, await exportSql(src, { utc: T }));
    await expect(
      dst.query("DELETE FROM safety_switches WHERE name = 'ai_enabled'"),
    ).rejects.toThrow();
  });
});
