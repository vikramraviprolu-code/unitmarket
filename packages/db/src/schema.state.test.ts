import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, migrate, openDatabase, tablesInDependencyOrder } from './index';
import { resetDatabase } from './testing';
import type { Database } from '@umsbx/contracts';

const T = '2026-10-21T10:00:00Z';
const T2 = '2026-10-21T11:00:00Z';
const T15 = '2026-10-21T10:15:00Z'; // approval expires_at = created_at + 15 minutes
const clock = { now: () => new Date(T) };
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

type Db = Database & { close(): Promise<void> };
let db: Db;
const toClose: Db[] = [];

async function fresh(): Promise<Db> {
  const d = await openDatabase({ kind: 'pglite-memory' });
  toClose.push(d);
  await migrate(d, clock);
  return d;
}
afterAll(async () => {
  for (const d of toClose) await d.close();
});

async function ins(table: string, row: Record<string, unknown>, withTimes = true) {
  const r = withTimes ? { created_at: T, updated_at: T, ...row } : row;
  const cols = Object.keys(r);
  await db.query(
    `INSERT INTO ${table} (${cols.map((c) => (c === 'on' ? '"on"' : c)).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}
const j = (v: unknown) => JSON.stringify(v);

async function base() {
  await ins('publishers', {
    id: 'pub_1',
    slug: 'p1',
    display_name: 'Pub One',
    country: 'US',
    paypal_merchant_id: 'MERCH1',
    payee_verified_at: T,
  });
  await ins('articles', {
    id: 'art_1',
    publisher_id: 'pub_1',
    title: 't',
    abstract: 'a',
    language: 'en',
    topics: ['x', 'y'],
    published_at: T,
    sha256: HASH,
    content_key: 'k1',
    bytes: 10,
    mime: 'text/plain',
  });
  await ins('buyers', { id: 'buy_1', display_name: 'B', auth_subject: 'sub1', country: 'US' });
}
async function approval(n: number, over: Record<string, unknown> = {}) {
  await ins('approvals', {
    id: `apr_${n}`,
    buyer_id: 'buy_1',
    snapshot: j({ v: 1 }),
    content_hash: HASH,
    nonce: `nonce${n}`,
    expires_at: T15,
    used_at: null,
    environment: 'dryrun',
    ...over,
  });
}
async function order(n: number, over: Record<string, unknown> = {}) {
  await approval(n);
  await ins('orders', {
    id: `ord_${n}`,
    approval_id: `apr_${n}`,
    buyer_id: 'buy_1',
    content_hash: HASH,
    order_ref: `ref_${n}`,
    expected: j({}),
    status: 'created',
    mismatch: false,
    corridor_id: 'us-usd',
    currency: 'USD',
    total_minor: 500,
    environment: 'dryrun',
    ...over,
  });
}
async function unit(n: number, orderN: number, over: Record<string, unknown> = {}) {
  await ins('order_units', {
    id: `unt_${n}`,
    order_id: `ord_${orderN}`,
    provider_order_ref: null,
    publisher_id: 'pub_1',
    reference_id: `refid_${n}`,
    payee_merchant_id: 'MERCH1',
    amount_minor: 500,
    platform_fee_minor: 0,
    capture_id: n === 1 ? 'CAP1' : null,
    status: 'expected',
    status_reason: null,
    paypal_fee_minor: null,
    refunded_minor: 0,
    captured_verified_at: null,
    mismatch_reason: null,
    ...over,
  });
}
async function ledger(n: number, over: Record<string, unknown> = {}) {
  await ins('ledger_entries', {
    id: `led_${n}`,
    unit_id: 'unt_1',
    capture_id: 'CAP1',
    kind: 'sale',
    amount_minor: 500,
    currency: 'USD',
    refund_id: null,
    ref_entry_id: null,
    environment: 'dryrun',
    ...over,
  });
}
async function entitlement(n: number, over: Record<string, unknown> = {}) {
  await ins('entitlements', {
    id: `ent_${n}`,
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
    ...over,
  });
}

// One PGlite per file keeps the suite fast: every test starts from an emptied schema plus the
// us-usd corridor (the one seed row the money tests need). Seed-row tests use their own database.
beforeAll(async () => {
  db = await fresh();
});
beforeEach(async () => {
  await resetDatabase(db);
  await ins('corridors', {
    id: 'us-usd',
    currency: 'USD',
    minor_units: 2,
    buyer_countries: ['US'],
    payee_countries: ['US'],
    domestic_supported: true,
    min_charge_minor: null,
    enabled: true,
  });
});

describe('migrations', () => {
  it('migrations apply on a fresh PGlite and again as a no-op', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    // Later migrations (0007 from another lane, 0008) are checked by name, not by count.
    expect(first.slice(0, 7)).toEqual([
      '0001_core',
      '0002_buyers',
      '0003_entry',
      '0004_money',
      '0005_access',
      '0006_platform',
      '0007_links_session',
    ]);
    expect(first).toContain('0008_access_events_unique');
    expect(first).toContain('0009_active_entitlement_unique');
    expect(first).toContain('0011_provider_order_state');
    expect(first).toContain('0012_publisher_side');
    expect(first).toContain('0013_publisher_applicants');
    expect(first).toContain('0014_publisher_visits');
    expect(await migrate(d, clock)).toEqual([]);
    const rows = await d.query<{ version: string; applied_at: Date | string }>(
      'SELECT version, applied_at FROM schema_migrations ORDER BY version',
    );
    expect(rows.rows).toHaveLength(first.length);
    expect(new Date(rows.rows[0]!.applied_at as string).toISOString()).toBe(
      '2026-10-21T10:00:00.000Z',
    );
  });
  it('a failing migration rolls back its own file only', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const dir = mkdtempSync(join(tmpdir(), 'ums-mig-'));
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE ok_t (id text PRIMARY KEY);');
      writeFileSync(
        join(dir, '0002_bad.sql'),
        'CREATE TABLE bad_t (id text PRIMARY KEY); SELECT 1/0;',
      );
      await expect(applyMigrations(d, clock, dir)).rejects.toThrow();
      expect((await d.query("SELECT to_regclass('ok_t') AS t")).rows[0]).toEqual({ t: 'ok_t' });
      expect((await d.query("SELECT to_regclass('bad_t') AS t")).rows[0]).toEqual({ t: null });
      expect((await d.query('SELECT version FROM schema_migrations')).rows).toEqual([
        { version: '0001_ok' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('common migrations carry no now(), no timestamp default, no extension (PORT-1, P16)', () => {
    const dir = new URL('../migrations/common/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const sql = readFileSync(new URL(f, dir), 'utf8').replace(/--.*$/gm, '');
      expect(sql, f).not.toMatch(/\bnow\s*\(/i);
      expect(sql, f).not.toMatch(
        /current_timestamp|clock_timestamp|statement_timestamp|transaction_timestamp/i,
      );
      // The allowed defaults: 0010 (D-041) publishers.payee_shared starts false for every row, and
      // 0012 (PUB-A1) publishers.status starts 'active' for every existing row.
      const withoutAllowed =
        f === '0010_publisher_payee_shared.sql'
          ? sql.replace(/payee_shared\s+boolean\s+NOT\s+NULL\s+DEFAULT\s+false/i, '')
          : f === '0012_publisher_side.sql'
            ? sql.replace(/status\s+text\s+NOT\s+NULL\s+DEFAULT\s+'active'/i, '')
            : sql;
      expect(withoutAllowed, f).not.toMatch(/\bDEFAULT\b/i);
      expect(sql, f).not.toMatch(/CREATE\s+EXTENSION/i);
    }
  });
  it('seeds the safety switches, the us-usd corridor and the two access policies', async () => {
    const db = await fresh();
    const sw = await db.query<{ name: string; on: boolean }>(
      'SELECT name, "on" FROM safety_switches ORDER BY name',
    );
    expect(sw.rows.map((r) => r.name)).toEqual([
      'agent_buy_enabled',
      'ai_enabled',
      'checkout_enabled',
      'paypal_outbound',
      'refunds_enabled',
      'unlock_enabled',
      'webhook_enabled',
    ]);
    expect(sw.rows.find((r) => r.name === 'paypal_outbound')!.on).toBe(false);
    const c = await db.query<{ id: string; currency: string; enabled: boolean }>(
      'SELECT id, currency, enabled FROM corridors',
    );
    expect(c.rows).toEqual([{ id: 'us-usd', currency: 'USD', enabled: true }]);
    const p = await db.query<{ id: string; option: string; version: string; window_ms: number }>(
      'SELECT id, option, version, window_ms FROM access_policies ORDER BY id',
    );
    expect(p.rows).toEqual([
      { id: 'keep_retrieve', option: 'keep_retrieve', version: '1', window_ms: 432000000 },
      { id: 'online_read', option: 'online_read', version: '1', window_ms: 432000000 },
    ]);
  });
  it('every table has id (or its natural key), created_at and updated_at without defaults', async () => {
    const t = await db.query<{ table_name: string; cols: string[] }>(
      `SELECT table_name, array_agg(column_name::text) AS cols FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name <> 'schema_migrations' GROUP BY table_name`,
    );
    expect(t.rows.length).toBeGreaterThanOrEqual(35);
    // MC2-L4: fx_rates is the one exception, by its spec (docs/specs/mc2-l4-fx-rates.md): an append-only table
    // keyed (date, quote) whose own stamp is fetched_at; it has no created_at or updated_at.
    // API-W0 (migration 0019, spec F1 and F3): api_keys is stamped by revoked_at and last_used_at and
    // event_outbox is append-only with occurred_at; the spec fixes their columns, so neither has updated_at.
    // API-B (migration 0021): a mandate reservation is stamped by created_at and settled_at, and its row changes
    // only when it settles; the spec fixes its columns, so it has no updated_at either.
    // BR-2 (migration 0027): a rule setting is append-only and stamped by created_at; RuleSettingRowSchema fixes
    // its columns, so it has no updated_at.
    const NO_UPDATED_AT = new Set([
      'api_keys',
      'event_outbox',
      'mandate_reservations',
      'rule_settings',
    ]);
    // INT-TR0 (migration 0023): the journal tables carry their own stamps (occurred_at, at, sealed day) and are
    // append-only or maintained by trigger; the spec fixes their columns, so none has created_at or updated_at.
    for (const r of t.rows.filter(
      (x) => x.table_name !== 'fx_rates' && !x.table_name.startsWith('trace_'),
    )) {
      expect(r.cols, r.table_name).toContain(NO_UPDATED_AT.has(r.table_name) ? 'id' : 'created_at');
      if (!NO_UPDATED_AT.has(r.table_name)) expect(r.cols, r.table_name).toContain('updated_at');
    }
    const defaults = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_default IS NOT NULL AND table_name <> 'schema_migrations'`,
    );
    // The allowed defaults: 0010 (D-041) publishers.payee_shared is false unless set, and 0012 (PUB-A1)
    // publishers.status is 'active' unless set.
    expect(
      [...defaults.rows].sort((a, b) =>
        String((a as { column_name: string }).column_name).localeCompare(
          String((b as { column_name: string }).column_name),
        ),
      ),
    ).toEqual([
      { table_name: 'publishers', column_name: 'payee_shared' },
      { table_name: 'publishers', column_name: 'status' },
    ]);
  });
  it('ums_id refuses blank, padded and control-character ids', async () => {
    for (const bad of ['', ' x', 'x ', 'a\nb', 'a​b']) {
      await expect(
        ins('buyers', {
          id: bad,
          display_name: 'B',
          auth_subject: `s-${bad.length}`,
          country: 'US',
        }),
      ).rejects.toThrow();
    }
  });
});

describe('append-only tables', () => {
  async function seedAppendOnly() {
    await base();
    await order(1);
    await unit(1, 1);
    await entitlement(1);
    await ledger(1);
    await ins('receipts', {
      id: 'rct_1',
      order_id: 'ord_1',
      version: 1,
      body: j({}),
      sha256: HASH,
      environment: 'dryrun',
    });
    await ins('provider_calls', {
      id: 'pcl_1',
      operation_id: null,
      operation: 'create_order',
      method: 'POST',
      path_template: '/v2/checkout/orders',
      http_status: 201,
      outcome: 'ok',
      debug_id: null,
      duration_ms: 5,
      transport_kind: 'dryrun',
      request_redacted: j({}),
      response_redacted: j({}),
      environment: 'dryrun',
    });
    await ins('access_events', {
      id: 'aev_1',
      entitlement_id: 'ent_1',
      kind: 'access_ready',
      at: T,
      source: 'system',
      evidence: j({}),
      environment: 'dryrun',
    });
    await ins('audit_log', {
      id: 'aud_1',
      actor_kind: 'system',
      actor_id: null,
      action: 'x',
      target: null,
      reason: null,
      detail: j({}),
    });
    await ins('outbound_approvals', {
      id: 'oap_1',
      approval_ref: 'ref1',
      scope: 'sandbox',
      operations: ['create_order'],
      max_amount_minor: 100,
      max_calls_per_day: 10,
      valid_until: T2,
      approved_by: 'owner',
    });
  }
  const TABLES = [
    'ledger_entries',
    'receipts',
    'provider_calls',
    'access_events',
    'audit_log',
    'outbound_approvals',
  ];

  it('UPDATE and DELETE on ledger_entries, receipts, provider_calls, access_events, audit_log, outbound_approvals raise', async () => {
    await seedAppendOnly();
    for (const t of TABLES) {
      await expect(
        db.query(`UPDATE ${t} SET updated_at = $1`, [T2]),
        `${t} update`,
      ).rejects.toThrow(/append-only/);
      await expect(db.query(`DELETE FROM ${t}`), `${t} delete`).rejects.toThrow(/append-only/);
      expect((await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]).toEqual({ n: 1 });
    }
  });
  it('TRUNCATE refused without the reset setting', async () => {
    await seedAppendOnly();
    for (const t of TABLES) {
      await expect(db.exec(`TRUNCATE ${t}`), t).rejects.toThrow(/TRUNCATE|append-only/);
    }
    await expect(db.exec('TRUNCATE orders CASCADE')).rejects.toThrow(/append-only/);
    expect((await db.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0]).toEqual({
      n: 1,
    });
    await expect(
      db.exec("SELECT set_config('ums.allow_reset', 'off', true); TRUNCATE ledger_entries"),
    ).rejects.toThrow();
  });
  it('resetDatabase empties everything, keeps schema_migrations, and leaves the guard armed', async () => {
    await seedAppendOnly();
    await resetDatabase(db);
    for (const t of TABLES)
      expect((await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]).toEqual({ n: 0 });
    expect((await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0]).toEqual({
      n: readdirSync(new URL('../migrations/common/', import.meta.url)).filter((f) =>
        f.endsWith('.sql'),
      ).length,
    });
    await expect(db.exec('TRUNCATE ledger_entries')).rejects.toThrow();
  });
  it('approvals: only used_at may be set, once; delete refused', async () => {
    await base();
    await approval(1);
    await expect(
      db.query("UPDATE approvals SET nonce = 'zzz' WHERE id = 'apr_1'"),
    ).rejects.toThrow();
    await expect(
      db.query(`UPDATE approvals SET content_hash = $1 WHERE id = 'apr_1'`, [HASH2]),
    ).rejects.toThrow();
    await expect(
      db.query(`UPDATE approvals SET snapshot = '{"v":2}' WHERE id = 'apr_1'`),
    ).rejects.toThrow();
    await expect(
      db.query(`UPDATE approvals SET expires_at = $1 WHERE id = 'apr_1'`, [T]),
    ).rejects.toThrow();
    await db.query(`UPDATE approvals SET used_at = $1 WHERE id = 'apr_1'`, [T15]);
    await expect(
      db.query(`UPDATE approvals SET used_at = $1 WHERE id = 'apr_1'`, [T]),
    ).rejects.toThrow();
    await expect(
      db.query(`UPDATE approvals SET used_at = NULL WHERE id = 'apr_1'`),
    ).rejects.toThrow();
    await expect(db.query(`DELETE FROM approvals WHERE id = 'apr_1'`)).rejects.toThrow();
    await expect(db.exec('TRUNCATE approvals CASCADE')).rejects.toThrow();
  });
});

describe('money constraints', () => {
  it('second open order for one buyer and hash violates the unique index', async () => {
    await base();
    await order(1);
    await expect(order(2)).rejects.toThrow(/duplicate key|unique/i);
  });
  it('a closed order frees the buyer and hash for a new open order', async () => {
    await base();
    await order(1, { status: 'abandoned' });
    await order(2);
    await db.query("UPDATE orders SET status = 'paid' WHERE id = 'ord_2'");
    await order(3);
    await expect(order(4)).rejects.toThrow(/duplicate key|unique/i);
  });
  it('order status accepts only the ten OrderStatus values', async () => {
    await base();
    await expect(order(1, { status: 'bogus' })).rejects.toThrow();
    for (const [i, s] of [
      'created',
      'awaiting_buyer',
      'capture_requested',
      'capture_claimed',
      'unresolved',
      'frozen',
    ].entries()) {
      await ins('buyers', {
        id: `buy_s${i}`,
        display_name: 'B',
        auth_subject: `ss${i}`,
        country: 'US',
      });
      await approval(10 + i, { buyer_id: `buy_s${i}` });
      await ins('orders', {
        id: `ord_s${i}`,
        approval_id: `apr_${10 + i}`,
        buyer_id: `buy_s${i}`,
        content_hash: HASH,
        order_ref: `rs${i}`,
        expected: j({}),
        status: s,
        mismatch: false,
        corridor_id: 'us-usd',
        currency: 'USD',
        total_minor: 1,
        environment: 'dryrun',
      });
    }
  });
  it('approval id is unique per order', async () => {
    await base();
    await order(1);
    await expect(
      ins('orders', {
        id: 'ord_9',
        approval_id: 'apr_1',
        buyer_id: 'buy_1',
        content_hash: HASH2,
        order_ref: 'ref_9',
        expected: j({}),
        status: 'created',
        mismatch: false,
        corridor_id: 'us-usd',
        currency: 'USD',
        total_minor: 1,
        environment: 'dryrun',
      }),
    ).rejects.toThrow();
  });
  it('orders currency must equal the corridor currency', async () => {
    await base();
    await expect(order(1, { currency: 'EUR' })).rejects.toThrow(/corridor|currency/i);
    await order(2);
    await expect(db.query("UPDATE orders SET currency = 'EUR' WHERE id = 'ord_2'")).rejects.toThrow(
      /corridor|currency/i,
    );
    await expect(order(3, { corridor_id: 'nope' })).rejects.toThrow();
  });
  it('capture_id unique across units, many null capture ids allowed', async () => {
    await base();
    await order(1);
    await unit(1, 1);
    await unit(2, 1);
    await db.query("UPDATE order_units SET capture_id = 'CAP1' WHERE id = 'unt_1'");
    await expect(
      db.query("UPDATE order_units SET capture_id = 'CAP1' WHERE id = 'unt_2'"),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
  it('unit: reference unique per order, platform fee must be 0, status and amounts checked', async () => {
    await base();
    await order(1);
    await unit(1, 1);
    await expect(unit(2, 1, { reference_id: 'refid_1' })).rejects.toThrow();
    await expect(unit(3, 1, { platform_fee_minor: 1 })).rejects.toThrow();
    await expect(unit(4, 1, { status: 'weird' })).rejects.toThrow();
    await expect(unit(5, 1, { amount_minor: -1 })).rejects.toThrow();
    await expect(unit(6, 1, { refunded_minor: null })).rejects.toThrow();
    for (const [i, s] of [
      'captured_verified',
      'pending',
      'declined',
      'mismatch',
      'partially_refunded',
      'refunded',
      'reversal_suspected',
      'reversed',
    ].entries()) {
      await unit(20 + i, 1, {
        status: s,
        capture_id: `CAPX${i}`,
        captured_verified_at: T,
      });
    }
  });
  it('ledger refuses a second (capture, refund, kind)', async () => {
    await base();
    await order(1);
    await unit(1, 1);
    await ledger(1);
    await expect(ledger(2)).rejects.toThrow(/duplicate key|unique/i);
    await ledger(3, { kind: 'refund', refund_id: 'RF1', amount_minor: 100 });
    await expect(
      ledger(4, { kind: 'refund', refund_id: 'RF1', amount_minor: 100 }),
    ).rejects.toThrow(/duplicate key|unique/i);
    await ledger(5, { kind: 'refund', refund_id: 'RF2', amount_minor: 50 });
    await ledger(6, { kind: 'paypal_fee', amount_minor: 30 });
    await expect(ledger(7, { kind: 'mystery' })).rejects.toThrow();
  });
  it('operations: kind, state and the lease, unknown and failed rules', async () => {
    await base();
    await order(1);
    const op = (n: number, over: Record<string, unknown>) =>
      ins('operations', {
        id: `opr_${n}`,
        order_id: 'ord_1',
        unit_id: null,
        kind: 'create',
        state: 'prepared',
        attempt: 0,
        request_id: `umsC-${n}`,
        first_sent_at: null,
        idem_safe_until: null,
        lease_until: T2,
        next_retry_at: null,
        reconcile_until: null,
        failure_reason: null,
        ...over,
      });
    await op(1, {});
    await expect(op(2, { kind: 'zap' })).rejects.toThrow();
    await expect(op(3, { state: 'prepared', lease_until: null })).rejects.toThrow();
    await expect(op(4, { state: 'unknown', reconcile_until: null })).rejects.toThrow();
    await op(5, { state: 'unknown', reconcile_until: T2 });
    await expect(op(6, { state: 'failed' })).rejects.toThrow();
    await expect(op(7, { state: 'confirmed', failure_reason: 'declined' })).rejects.toThrow();
    await op(8, { state: 'failed', failure_reason: 'rejected', lease_until: null });
    await expect(op(9, { request_id: 'umsC-1' })).rejects.toThrow(/duplicate key|unique/i);
    await expect(op(10, { attempt: -1 })).rejects.toThrow();
    for (const [i, k] of ['capture', 'readback', 'refund', 'refund_readback'].entries())
      await op(20 + i, { kind: k });
  });
  it('environment refuses live (P15)', async () => {
    await base();
    await expect(approval(1, { environment: 'live' })).rejects.toThrow();
    await expect(order(2, { environment: 'live' })).rejects.toThrow();
    await order(3);
    await unit(1, 3);
    await expect(entitlement(1, { environment: 'live' })).rejects.toThrow();
    await expect(ledger(1, { environment: 'live' })).rejects.toThrow();
    await expect(
      ins('provider_calls', {
        id: 'pcl_x',
        operation_id: null,
        operation: 'create_order',
        method: 'POST',
        path_template: '/p',
        http_status: null,
        outcome: 'ok',
        debug_id: null,
        duration_ms: 1,
        transport_kind: 'live',
        request_redacted: j({}),
        response_redacted: j({}),
        environment: 'dryrun',
      }),
    ).rejects.toThrow();
    await expect(
      ins('webhook_events', {
        id: 'whk_1',
        event_id: 'e1',
        transmission_id: 't1',
        type: 'OTHER',
        verified: true,
        outcome: null,
        resource: j({}),
        received_at: T,
        applied_at: null,
        environment: 'live',
      }),
    ).rejects.toThrow();
    await expect(
      ins('receipts', {
        id: 'rct_x',
        order_id: 'ord_3',
        version: 1,
        body: j({}),
        sha256: HASH,
        environment: 'live',
      }),
    ).rejects.toThrow();
  });
  it('webhook event id and transmission id are unique', async () => {
    const w = (n: number, over: Record<string, unknown> = {}) =>
      ins('webhook_events', {
        id: `whk_${n}`,
        event_id: `e${n}`,
        transmission_id: `t${n}`,
        type: 'OTHER',
        verified: true,
        outcome: null,
        resource: j({}),
        received_at: T,
        applied_at: null,
        environment: 'sandbox',
        ...over,
      });
    await w(1);
    await expect(w(2, { event_id: 'e1' })).rejects.toThrow(/duplicate key|unique/i);
    await expect(w(3, { transmission_id: 't1' })).rejects.toThrow(/duplicate key|unique/i);
  });
  it('receipt version is unique per order', async () => {
    await base();
    await order(1);
    const r = (n: number, v: number) =>
      ins('receipts', {
        id: `rct_${n}`,
        order_id: 'ord_1',
        version: v,
        body: j({}),
        sha256: HASH,
        environment: 'dryrun',
      });
    await r(1, 1);
    await expect(r(2, 1)).rejects.toThrow(/duplicate key|unique/i);
    await r(3, 2);
  });
  it('provider_order id unique, route checked', async () => {
    await base();
    await order(1);
    const p = (n: number, over: Record<string, unknown> = {}) =>
      ins('provider_orders', {
        id: `pvo_${n}`,
        order_id: 'ord_1',
        provider_order_id: `PP${n}`,
        route: 'single',
        approve_url: null,
        status: null,
        // 0011: position, po_ref and state are required (DP-2a); one row per n on the same order.
        position: n,
        po_ref: `ord_1-p${n}`,
        state: 'prepared',
        ...over,
      });
    await p(1);
    await expect(p(2, { provider_order_id: 'PP1' })).rejects.toThrow(/duplicate key|unique/i);
    await expect(p(3, { route: 'both' })).rejects.toThrow();
    await p(4, { provider_order_id: null });
    await p(5, { provider_order_id: null });
  });
});

describe('access constraints', () => {
  it('entitlement CHECK refuses available without captured', async () => {
    await base();
    await order(1);
    await unit(1, 1);
    await expect(
      entitlement(1, { access_state: 'available', money_state: 'pending', licence_state: null }),
    ).rejects.toThrow();
    await expect(
      entitlement(2, {
        access_state: 'available',
        money_state: 'refunded',
        licence_state: 'terminated',
      }),
    ).rejects.toThrow();
    await entitlement(3, {
      access_state: 'available',
      money_state: 'captured',
      licence_state: 'granted',
    });
  });
  it('licence is set exactly when money is captured, refunded or reversed', async () => {
    await base();
    await order(1);
    await unit(1, 1);
    await expect(
      entitlement(1, { money_state: 'captured', licence_state: null }),
    ).rejects.toThrow();
    await expect(
      entitlement(2, { money_state: 'pending', licence_state: 'granted' }),
    ).rejects.toThrow();
    await expect(
      entitlement(3, { money_state: 'unknown', licence_state: 'granted' }),
    ).rejects.toThrow();
    await entitlement(4, { money_state: 'pending', licence_state: null });
  });
  it('one entitlement per (unit, article); option and states checked', async () => {
    await base();
    await order(1);
    await unit(1, 1);
    await entitlement(1);
    await expect(entitlement(2)).rejects.toThrow(/duplicate key|unique/i);
    await expect(entitlement(3, { option: 'mystery' })).rejects.toThrow();
    await expect(entitlement(4, { access_state: 'unlocked' })).rejects.toThrow();
  });
  it('access window credit is not negative; window is one per entitlement', async () => {
    await base();
    await order(1);
    await unit(1, 1);
    await entitlement(1);
    const w = (over: Record<string, unknown>) =>
      ins('access_windows', {
        entitlement_id: 'ent_1',
        state: 'not_started',
        started_at: null,
        base_ends_at: null,
        ends_at: null,
        paused_at: null,
        credit_ms: 0,
        ...over,
      });
    await expect(w({ credit_ms: -1 })).rejects.toThrow();
    await expect(w({ state: 'bogus' })).rejects.toThrow();
    await w({});
    await expect(w({})).rejects.toThrow();
  });
  it('link_issued is unique per link; other delivery evidence is repeatable (0008)', async () => {
    await base();
    await order(1);
    await unit(1, 1);
    await entitlement(1);
    await ins('links', {
      id: 'lnk_1',
      entitlement_id: 'ent_1',
      buyer_id: 'buy_1',
      token_hash: HASH,
      expires_at: T2,
      uses: 0,
    });
    const ev = (n: number, over: Record<string, unknown>) =>
      ins('access_events', {
        id: `aev_${n}`,
        entitlement_id: 'ent_1',
        kind: 'link_issued',
        at: T,
        source: 'buyer',
        evidence: j({}),
        link_id: 'lnk_1',
        environment: 'dryrun',
        ...over,
      });
    await ev(1, {});
    await expect(ev(2, {})).rejects.toThrow(/duplicate key|unique/i);
    await ev(3, { kind: 'download_aborted' });
    await ev(7, { kind: 'download_completed' });
    await ev(8, { kind: 'download_completed' });
    await ev(9, { kind: 'delivery_failed' });
    await ev(10, { kind: 'delivery_failed' });
    await ev(4, { link_id: null });
    await ev(5, { link_id: null });
    await expect(ev(6, { kind: 'nonsense', link_id: null })).rejects.toThrow();
    await expect(
      ins('links', {
        id: 'lnk_2',
        entitlement_id: 'ent_1',
        buyer_id: 'buy_1',
        token_hash: HASH,
        expires_at: T2,
        uses: 0,
      }),
    ).rejects.toThrow();
  });
});

describe('platform constraints', () => {
  it('alerts: one per kind, order, unit and reason; NULLs compare equal', async () => {
    await base();
    await order(1);
    const a = (n: number, over: Record<string, unknown>) =>
      ins('alerts', {
        id: `alr_${n}`,
        kind: 'order_mismatch',
        order_id: 'ord_1',
        unit_id: null,
        detail: j({ reason: 'amount' }),
        ...over,
      });
    await a(1, {});
    await expect(a(2, {})).rejects.toThrow(/duplicate key|unique/i);
    await a(3, { detail: j({ reason: 'payee' }) });
    await a(4, { detail: j({}) });
    await expect(a(5, { detail: j({}) })).rejects.toThrow(/duplicate key|unique/i);
  });
  it('api_idempotency is unique per (actor_kind, actor_id, key)', async () => {
    const k = (n: number, over: Record<string, unknown> = {}) =>
      ins('api_idempotency', {
        id: `idk_${n}`,
        key: 'K1',
        actor_kind: 'buyer',
        actor_id: 'buy_1',
        route: 'POST /api/orders',
        request_sha256: HASH,
        response: j({}),
        ...over,
      });
    await k(1);
    await expect(k(2)).rejects.toThrow(/duplicate key|unique/i);
    await k(3, { actor_id: 'buy_2' });
    await k(4, { key: 'K2' });
  });
  it('recovery case kind and state are checked', async () => {
    const c = (n: number, over: Record<string, unknown>) =>
      ins('recovery_cases', {
        id: `cas_${n}`,
        kind: 'delivery_failed',
        state: 'open',
        order_id: null,
        entitlement_id: null,
        buyer_id: null,
        opened_by: 'system',
        sla_due_at: T2,
        credit_ms: 0,
        buyer_message: 'm',
        ...over,
      });
    await c(1, {});
    await expect(c(2, { kind: 'x' })).rejects.toThrow();
    await expect(c(3, { state: 'x' })).rejects.toThrow();
    await expect(c(4, { credit_ms: -5 })).rejects.toThrow();
  });
  it('recovery_actions are append-only', async () => {
    await ins('recovery_cases', {
      id: 'cas_1',
      kind: 'delivery_failed',
      state: 'open',
      order_id: null,
      entitlement_id: null,
      buyer_id: null,
      opened_by: 'system',
      sla_due_at: T2,
      credit_ms: 0,
      buyer_message: 'm',
    });
    await ins('recovery_actions', {
      id: 'rca_1',
      case_id: 'cas_1',
      action: 'note',
      actor: 'op',
      detail: j({}),
      at: T,
    });
    await expect(db.query("UPDATE recovery_actions SET action = 'x'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query('DELETE FROM recovery_actions')).rejects.toThrow(/append-only/);
    await expect(db.exec('TRUNCATE recovery_actions')).rejects.toThrow();
  });
  it('catalogue: offers and policies are versioned; publisher authorisations are append-only', async () => {
    await base();
    const o = (v: string) =>
      ins('offers', {
        id: 'ofr_1',
        version: v,
        publisher_id: 'pub_1',
        article_id: 'art_1',
        status: 'authorised',
        currency: 'USD',
        options: j([]),
        affordability: j({}),
        terms_version: 't1',
        rights: j({}),
        valid_from: T,
        valid_until: null,
        superseded_by: null,
      });
    await o('1');
    await o('2');
    await expect(o('2')).rejects.toThrow();
    await ins('publisher_authorisations', {
      id: 'pau_1',
      offer_id: 'ofr_1',
      offer_version: '2',
      authorised_by: 'pub_1',
      at: T,
    });
    await expect(
      ins('publisher_authorisations', {
        id: 'pau_2',
        offer_id: 'ofr_1',
        offer_version: '9',
        authorised_by: 'pub_1',
        at: T,
      }),
    ).rejects.toThrow();
    await expect(
      db.query("UPDATE publisher_authorisations SET authorised_by = 'x'"),
    ).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM publisher_authorisations')).rejects.toThrow(/append-only/);
    const pol = (over: Record<string, unknown> = {}) =>
      ins('access_policies', {
        id: 'keep_retrieve',
        version: '1',
        option: 'keep_retrieve',
        window_ms: 1,
        start_rule: 'payment_verified_and_delivery_ready',
        ...over,
      });
    await pol();
    await expect(pol()).rejects.toThrow();
    await pol({ version: '2' });
    await expect(pol({ version: '3', window_ms: 0 })).rejects.toThrow();
    await expect(pol({ version: '4', start_rule: 'now' })).rejects.toThrow();
  });
  it('quotes reference an offer version and a corridor', async () => {
    await base();
    await ins('offers', {
      id: 'ofr_1',
      version: '1',
      publisher_id: 'pub_1',
      article_id: 'art_1',
      status: 'authorised',
      currency: 'USD',
      options: j([]),
      affordability: j({}),
      terms_version: 't1',
      rights: j({}),
      valid_from: T,
      valid_until: null,
      superseded_by: null,
    });
    const q = (n: number, over: Record<string, unknown> = {}) =>
      ins('quotes', {
        id: `quo_${n}`,
        buyer_id: null,
        offer_id: 'ofr_1',
        offer_version: '1',
        option: 'keep_retrieve',
        price_minor: 100,
        currency: 'USD',
        corridor_id: 'us-usd',
        source: 'direct',
        expires_at: T2,
        ...over,
      });
    await q(1);
    await expect(q(2, { offer_version: '7' })).rejects.toThrow();
    await expect(q(3, { corridor_id: 'zz' })).rejects.toThrow();
    await expect(q(4, { source: 'x' })).rejects.toThrow();
  });
  it('rate bucket and safety switch use their natural key', async () => {
    await ins('rate_buckets', { bucket_key: 'ip:1', tokens: 5, refilled_at: T });
    await expect(
      ins('rate_buckets', { bucket_key: 'ip:1', tokens: 5, refilled_at: T }),
    ).rejects.toThrow();
    const sw = (name: string) =>
      ins('safety_switches', { name, on: false, changed_by: 'x', changed_at: T, reason: 'r' });
    await sw('paypal_outbound');
    await expect(sw('paypal_outbound')).rejects.toThrow();
    await expect(sw('made_up_switch')).rejects.toThrow();
  });
});

describe('introspection', () => {
  it('tablesInDependencyOrder lists parents before children', async () => {
    const order_ = await tablesInDependencyOrder(db);
    const pos = (t: string) => order_.indexOf(t);
    const fks = await db.query<{ child: string; parent: string }>(
      `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
       FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND c.conrelid <> c.confrelid`,
    );
    expect(fks.rows.length).toBeGreaterThan(20);
    for (const r of fks.rows)
      expect(pos(r.parent), `${r.parent} before ${r.child}`).toBeLessThan(pos(r.child));
    expect(order_).not.toContain('schema_migrations');
    expect(new Set(order_).size).toBe(order_.length);
    expect(order_.slice().sort()).toEqual(
      (
        await db.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY tablename",
        )
      ).rows.map((r) => r.tablename),
    );
  });
});

describe('drivers', () => {
  it('pglite-disk survives close and reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ums-disk-'));
    try {
      const a = await openDatabase({ kind: 'pglite-disk', dir });
      await migrate(a, clock);
      await a.query(
        "INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ('buy_d', 'D', 'sd', 'US', $1, $1)",
        [T],
      );
      await a.close();
      const b = await openDatabase({ kind: 'pglite-disk', dir });
      expect((await b.query('SELECT id FROM buyers')).rows).toEqual([{ id: 'buy_d' }]);
      expect(await migrate(b, clock)).toEqual([]);
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('transaction commits on success and rolls back on throw', async () => {
    await db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ('buy_t', 'T', 'st', 'US', $1, $1)",
        [T],
      );
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ('buy_u', 'U', 'su', 'US', $1, $1)",
          [T],
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await db.query('SELECT id FROM buyers ORDER BY id')).rows).toEqual([{ id: 'buy_t' }]);
    expect(db.dialect).toBe('pglite');
  });
});

// Wave 1 review A: constraints that must hold in the database, not only in the application.
describe('review A: ledger integrity (H1)', () => {
  async function sale() {
    await base();
    await order(1);
    await unit(1, 1);
    await ledger(1);
  }
  it('H1: only one sale row per capture, whatever its refund_id', async () => {
    await sale();
    await expect(ledger(2)).rejects.toThrow();
    await expect(ledger(3, { refund_id: 'RFX' })).rejects.toThrow();
    await expect(ledger(4, { refund_id: 'RFY' })).rejects.toThrow();
    const idx = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'ledger_entries' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%kind = ''sale''%'",
    );
    expect(idx.rows.length).toBe(1);
  });
  it('H1: refund and commission_reversal rows need a refund_id; other kinds must not carry one', async () => {
    await sale();
    await expect(ledger(2, { kind: 'refund', amount_minor: 10 })).rejects.toThrow(/check/i);
    await expect(ledger(3, { kind: 'commission_reversal', amount_minor: 0 })).rejects.toThrow(
      /check/i,
    );
    await expect(
      ledger(4, { kind: 'paypal_fee', refund_id: 'RF1', amount_minor: 1 }),
    ).rejects.toThrow(/check/i);
    await ledger(5, { kind: 'refund', refund_id: 'RF1', amount_minor: 10 });
    await ledger(6, { kind: 'commission_reversal', refund_id: 'RF1', amount_minor: 0 });
  });
  it('H1: refunds per capture cannot exceed the sale, singly or cumulatively', async () => {
    await sale();
    await expect(
      ledger(2, { kind: 'refund', refund_id: 'RF1', amount_minor: 999999 }),
    ).rejects.toThrow(/exceed/i);
    await ledger(3, { kind: 'refund', refund_id: 'RF2', amount_minor: 300 });
    await expect(
      ledger(4, { kind: 'refund', refund_id: 'RF3', amount_minor: 300 }),
    ).rejects.toThrow(/exceed/i);
    await ledger(5, { kind: 'refund', refund_id: 'RF4', amount_minor: 200 });
  });
  it('H1: a refund with no sale row is refused', async () => {
    await base();
    await order(1);
    await unit(1, 1);
    await expect(ledger(1, { kind: 'refund', refund_id: 'RF1', amount_minor: 1 })).rejects.toThrow(
      /exceed|sale/i,
    );
  });
  it('H1: ledger currency must equal the order currency', async () => {
    await sale();
    await expect(
      ledger(2, { kind: 'paypal_fee', amount_minor: 5, currency: 'EUR' }),
    ).rejects.toThrow(/currency/i);
    await expect(ledger(3, { id: 'led_e', currency: 'EUR', capture_id: 'CAP1' })).rejects.toThrow();
  });
  it('H1: a ledger capture_id must be the capture of its unit', async () => {
    await sale();
    await expect(
      ledger(2, { kind: 'paypal_fee', amount_minor: 5, capture_id: 'NOT_ON_ANY_UNIT' }),
    ).rejects.toThrow(/foreign key|violates/i);
    await unit(2, 1, { capture_id: 'CAP2' });
    await expect(
      ledger(3, { kind: 'paypal_fee', amount_minor: 5, unit_id: 'unt_1', capture_id: 'CAP2' }),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

describe('review A: order unit status needs a verified capture (M1)', () => {
  it('M1: captured states refuse a null capture_id or captured_verified_at', async () => {
    await base();
    await order(1);
    let i = 10;
    for (const s of [
      'captured_verified',
      'partially_refunded',
      'refunded',
      'reversal_suspected',
      'reversed',
    ]) {
      await expect(
        unit(i++, 1, { status: s, capture_id: null, captured_verified_at: T }),
        `${s} without capture_id`,
      ).rejects.toThrow(/check/i);
      await expect(
        unit(i++, 1, { status: s, capture_id: `CAPM${i}`, captured_verified_at: null }),
        `${s} without captured_verified_at`,
      ).rejects.toThrow(/check/i);
      await unit(i++, 1, { status: s, capture_id: `CAPM${i}`, captured_verified_at: T });
    }
    await unit(i++, 1, { status: 'pending' });
  });
});

describe('review A: provider order approve_url (M2)', () => {
  it('M2: approve_url must be on the sandbox host', async () => {
    await base();
    await order(1);
    const po = (n: number, url: string | null) =>
      ins('provider_orders', {
        id: `po_${n}`,
        order_id: 'ord_1',
        provider_order_id: null,
        route: 'single',
        approve_url: url,
        status: null,
        // 0011: position, po_ref and state are required (DP-2a); one row per n on the same order.
        position: n,
        po_ref: `ord_1-p${n}`,
        state: 'prepared',
      });
    await po(1, null);
    await po(2, 'https://www.sandbox.paypal.com/checkoutnow?token=ABC');
    for (const [n, bad] of [
      [3, `https://www.${'paypal'}.com/checkoutnow?token=ABC`],
      [4, 'http://www.sandbox.paypal.com/x'],
      [5, 'https://evil.example/https://www.sandbox.paypal.com/'],
      [6, 'javascript:alert(1)'],
      [7, 'https://www.sandbox.paypal.com.evil.example/x'],
    ] as const) {
      await expect(po(n, bad), bad).rejects.toThrow(/check/i);
    }
  });
});

describe('review A: approvals and orders agree (M7)', () => {
  it('M7: expires_at must be created_at + 15 minutes', async () => {
    await base();
    await expect(approval(1, { expires_at: T2 })).rejects.toThrow(/check/i);
    await expect(approval(2, { expires_at: T })).rejects.toThrow(/check/i);
    await approval(3);
  });
  it('M7: used_at cannot be later than expires_at', async () => {
    await base();
    await expect(approval(1, { used_at: T2 })).rejects.toThrow(/check/i);
    await approval(2, { used_at: T15 });
    await approval(3);
    await expect(
      db.query("UPDATE approvals SET used_at = $1 WHERE id = 'apr_3'", [T2]),
    ).rejects.toThrow();
    await db.query("UPDATE approvals SET used_at = $1 WHERE id = 'apr_3'", [T15]);
  });
  it('M7: an order must carry its approval buyer and environment', async () => {
    await base();
    await ins('buyers', { id: 'buy_2', display_name: 'B2', auth_subject: 'sub2', country: 'US' });
    await approval(1);
    await approval(2, { environment: 'sandbox' });
    const mk = (id: string, approvalId: string, buyer: string, env: string, ref: string) =>
      ins('orders', {
        id,
        approval_id: approvalId,
        buyer_id: buyer,
        content_hash: HASH,
        order_ref: ref,
        expected: j({}),
        status: 'created',
        mismatch: false,
        corridor_id: 'us-usd',
        currency: 'USD',
        total_minor: 500,
        environment: env,
      });
    await expect(mk('ord_a', 'apr_1', 'buy_2', 'dryrun', 'ra')).rejects.toThrow(/approval/i);
    await expect(mk('ord_b', 'apr_1', 'buy_1', 'sandbox', 'rb')).rejects.toThrow(/approval/i);
    await expect(mk('ord_c', 'apr_2', 'buy_1', 'dryrun', 'rc')).rejects.toThrow(/approval/i);
    await mk('ord_d', 'apr_1', 'buy_1', 'dryrun', 'rd');
    await expect(
      db.query("UPDATE orders SET buyer_id = 'buy_2' WHERE id = 'ord_d'"),
    ).rejects.toThrow(/approval/i);
  });
});

describe('review A: safety switches are not deletable (M8)', () => {
  it('M8: DELETE and TRUNCATE of safety_switches are refused, UPDATE still works', async () => {
    await ins('safety_switches', {
      name: 'paypal_outbound',
      on: false,
      changed_by: 'x',
      changed_at: T,
      reason: 'r',
    });
    await expect(
      db.query("DELETE FROM safety_switches WHERE name = 'paypal_outbound'"),
    ).rejects.toThrow(/not allowed|cannot be deleted/i);
    await expect(db.exec('TRUNCATE safety_switches')).rejects.toThrow();
    await db.query('UPDATE safety_switches SET "on" = true WHERE name = \'paypal_outbound\'');
    expect((await db.query('SELECT count(*)::int AS n FROM safety_switches')).rows[0]).toEqual({
      n: 1,
    });
  });
});

describe('review A: outbound approvals list known operations (L4)', () => {
  it('L4: operations must be PayPal operation names', async () => {
    const oap = (n: number, operations: string[]) =>
      ins('outbound_approvals', {
        id: `oap_${n}`,
        approval_ref: `ref${n}`,
        scope: 'sandbox',
        operations,
        max_amount_minor: 100,
        max_calls_per_day: 10,
        valid_until: T2,
        approved_by: 'owner',
      });
    await oap(1, ['create_order', 'capture_order']);
    await expect(oap(2, ['drop_all_tables'])).rejects.toThrow(/check/i);
    await expect(oap(3, ['create_order', 'nope'])).rejects.toThrow(/check/i);
  });
});

describe('review A: ids reject bidi and invisible characters (L2)', () => {
  it('L2: ums_id refuses bidi controls, word joiner and unicode edge whitespace', async () => {
    const bad = ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', '⁠', '​', '﻿', '\u0085'];
    for (const [i, ch] of bad.entries()) {
      await expect(
        ins('buyers', { id: `a${ch}b`, display_name: 'B', auth_subject: `s${i}`, country: 'US' }),
        `U+${ch.codePointAt(0)!.toString(16)}`,
      ).rejects.toThrow();
    }
    await expect(
      ins('buyers', { id: ' x', display_name: 'B', auth_subject: 'n1', country: 'US' }),
    ).rejects.toThrow();
    await expect(
      ins('buyers', { id: 'x　', display_name: 'B', auth_subject: 'n2', country: 'US' }),
    ).rejects.toThrow();
    await ins('buyers', { id: 'ok id é', display_name: 'B', auth_subject: 'ok1', country: 'US' });
  });
});

describe('review A: reset guard (M4)', () => {
  async function disk() {
    const dir = mkdtempSync(join(tmpdir(), 'ums-reset-'));
    const d = await openDatabase({ kind: 'pglite-disk', dir });
    toClose.push(d);
    await migrate(d, clock);
    return d;
  }
  it('M4: a plain ums.allow_reset setting does not satisfy the TRUNCATE guard on a disk target', async () => {
    const d = await disk();
    await expect(
      d.exec("SELECT set_config('ums.allow_reset', 'on', true); TRUNCATE ledger_entries"),
    ).rejects.toThrow(/not allowed/i);
    await expect(
      d.exec("SELECT set_config('ums.allow_reset', 'on', false); TRUNCATE ledger_entries"),
    ).rejects.toThrow(/not allowed/i);
  });
  it('M4: resetDatabase refuses a disk target unless the explicit test flag is given', async () => {
    const d = await disk();
    await expect(resetDatabase(d)).rejects.toThrow(/memory|refus/i);
    await resetDatabase(d, { confirm: 'RESET_TEST_DATABASE' });
  });
  it('M4: resetDatabase refuses a driver that does not say where it runs', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    await migrate(d, clock);
    const anonymous = {
      dialect: d.dialect,
      query: d.query,
      exec: d.exec,
      transaction: d.transaction,
    };
    await expect(resetDatabase(anonymous)).rejects.toThrow(/memory|refus/i);
  });
  it('M4: a memory target still resets without any flag', async () => {
    const d = await fresh();
    await expect(resetDatabase(d)).resolves.toBeUndefined();
  });
});

describe('review A: approval immutability (L3)', () => {
  it('L3: used_at cannot be set in the same UPDATE as any other frozen column', async () => {
    await base();
    await ins('buyers', { id: 'buy_2', display_name: 'B2', auth_subject: 'sub2', country: 'US' });
    const other: [string, unknown][] = [
      ['nonce', 'zzz'],
      ['content_hash', HASH2],
      ['snapshot', '{"v":2}'],
      ['buyer_id', 'buy_2'],
      ['environment', 'sandbox'],
      ['created_at', T2],
      ['expires_at', T2],
    ];
    for (const [i, [column, value]] of other.entries()) {
      // a fresh approval per column; created_at/expires_at keep the +15 minute rule where needed
      await approval(100 + i);
      const change =
        column === 'created_at'
          ? ["created_at = $2, expires_at = $2::timestamptz + interval '15 minutes'", value]
          : [`${column} = $2`, value];
      await expect(
        db.query(`UPDATE approvals SET used_at = $1, ${change[0]} WHERE id = 'apr_${100 + i}'`, [
          T15,
          change[1],
        ]),
        column,
      ).rejects.toThrow();
      const row = await db.query<{ used_at: string | null }>(
        `SELECT used_at FROM approvals WHERE id = 'apr_${100 + i}'`,
      );
      expect(row.rows[0]?.used_at, column).toBeNull();
    }
    // the allowed form still works
    await approval(200);
    await db.query(`UPDATE approvals SET used_at = $1 WHERE id = 'apr_200'`, [T15]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('0010 publishers.payee_shared (DP-1, D-041)', () => {
  const pub = (n: number, over: Record<string, unknown> = {}) =>
    ins('publishers', {
      id: `pub_s${n}`,
      slug: `ps${n}`,
      display_name: `Pub ${n}`,
      country: 'US',
      paypal_merchant_id: 'SBXPAYEESHARED1',
      payee_verified_at: T,
      ...over,
    });
  const isUnique = (e: unknown) => (e as { code?: unknown }).code === '23505';

  it('0010 recorded by name', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const applied = await migrate(d, clock);
    expect(applied).toContain('0010_publisher_payee_shared');
    const rows = await d.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = '0010_publisher_payee_shared'",
    );
    expect(rows.rows).toEqual([{ version: '0010_publisher_payee_shared' }]);
    expect(await migrate(d, clock)).toEqual([]);
  });

  it('payee_shared is a boolean NOT NULL column that defaults to false', async () => {
    const c = await db.query<{ data_type: string; is_nullable: string; column_default: string }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'publishers' AND column_name = 'payee_shared'`,
    );
    expect(c.rows).toEqual([{ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }]);
    await pub(1, { paypal_merchant_id: 'SBXPAYEEA' });
    expect((await db.query('SELECT payee_shared FROM publishers')).rows).toEqual([
      { payee_shared: false },
    ]);
    await expect(pub(2, { paypal_merchant_id: 'SBXPAYEEB', payee_shared: null })).rejects.toThrow();
  });

  it('two publishers with payee_shared may share a merchant id', async () => {
    await pub(1, { payee_shared: true });
    await pub(2, { payee_shared: true });
    const r = await db.query('SELECT id FROM publishers WHERE paypal_merchant_id = $1', [
      'SBXPAYEESHARED1',
    ]);
    expect(r.rows).toHaveLength(2);
  });

  it('two without the flag may not (23505)', async () => {
    await pub(1);
    const e = await pub(2).then(
      () => null,
      (x: unknown) => x,
    );
    expect(isUnique(e)).toBe(true);
    expect((await db.query('SELECT id FROM publishers')).rows).toHaveLength(1);
  });

  it('the old plain unique constraint is gone and the partial index is in place', async () => {
    const c = await db.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'publishers_paypal_merchant_id_key'",
    );
    expect(c.rows).toEqual([]);
    const i = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'publishers_merchant_unshared'",
    );
    expect(i.rows).toHaveLength(1);
    expect(i.rows[0]!.indexdef).toMatch(/UNIQUE/);
    expect(i.rows[0]!.indexdef).toMatch(/paypal_merchant_id/);
    expect(i.rows[0]!.indexdef).toMatch(/NOT payee_shared/);
  });

  it('one flagged and one unflagged with the same id: refused', async () => {
    await pub(1, { payee_shared: true });
    await expect(pub(2)).rejects.toThrow();
    expect((await db.query('SELECT id FROM publishers')).rows).toHaveLength(1);
    // and the other way round
    await resetDatabase(db);
    await pub(1);
    await expect(pub(2, { payee_shared: true })).rejects.toThrow();
    expect((await db.query('SELECT id FROM publishers')).rows).toHaveLength(1);
  });

  it('the rule holds on UPDATE too: setting an id or clearing the flag cannot create a clash', async () => {
    await pub(1, { payee_shared: true });
    await pub(2, { payee_shared: true });
    await pub(3, { paypal_merchant_id: 'SBXPAYEEOTHER' });
    // clearing the flag on one of a shared pair
    await expect(
      db.query(`UPDATE publishers SET payee_shared = false WHERE id = 'pub_s2'`),
    ).rejects.toThrow();
    // an unflagged publisher taking a shared id
    await expect(
      db.query(`UPDATE publishers SET paypal_merchant_id = 'SBXPAYEESHARED1' WHERE id = 'pub_s3'`),
    ).rejects.toThrow();
    // a flagged publisher taking an unflagged one's id
    await expect(
      db.query(
        `UPDATE publishers SET payee_shared = true, paypal_merchant_id = 'SBXPAYEEOTHER' WHERE id = 'pub_s1'`,
      ),
    ).rejects.toThrow();
    // an update that changes nothing about the id or flag is fine
    await db.query(`UPDATE publishers SET display_name = 'Renamed' WHERE id = 'pub_s1'`);
    // moving to a free id, flagged or not, is fine
    await db.query(`UPDATE publishers SET paypal_merchant_id = 'SBXPAYEEFREE' WHERE id = 'pub_s3'`);
  });

  it('publishers without a merchant id are unlimited, flagged or not', async () => {
    await pub(1, { paypal_merchant_id: null, payee_verified_at: null });
    await pub(2, { paypal_merchant_id: null, payee_verified_at: null });
    await pub(3, { paypal_merchant_id: null, payee_verified_at: null, payee_shared: true });
    expect((await db.query('SELECT id FROM publishers')).rows).toHaveLength(3);
  });

  it('a logical export and import of a shared pair round-trips (the guard re-checks the load)', async () => {
    const { exportSql, importSql } = await import('./export-sql');
    await pub(1, { payee_shared: true });
    await pub(2, { payee_shared: true });
    const text = await exportSql(db, { utc: T });
    const target = await fresh();
    await importSql(target, text);
    const r = await target.query<{ id: string; payee_shared: boolean }>(
      'SELECT id, payee_shared FROM publishers ORDER BY id',
    );
    expect(r.rows).toEqual([
      { id: 'pub_s1', payee_shared: true },
      { id: 'pub_s2', payee_shared: true },
    ]);
  });

  it('migration 0010 is forward-only and safe on a copy of an MVP-C-shaped database', async () => {
    // A database migrated to 0009 only, holding what the MVP-C disk holds: harbour-ledger with the
    // owner's merchant id, verified, and a second publisher with none.
    const dir = mkdtempSync(join(tmpdir(), 'ums-mig10-'));
    try {
      const { writeFileSync } = await import('node:fs');
      const common = new URL('../migrations/common/', import.meta.url);
      for (const f of readdirSync(common).filter((n) => /^000[1-9]_.+\.sql$/.test(n))) {
        writeFileSync(join(dir, f), readFileSync(new URL(f, common), 'utf8'));
      }
      const d = await openDatabase({ kind: 'pglite-memory' });
      toClose.push(d);
      expect((await applyMigrations(d, clock, dir)).at(-1)).toBe('0009_active_entitlement_unique');
      const add = (id: string, slug: string, merchant: string | null) =>
        d.query(
          `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, payee_verified_at, created_at, updated_at)
           VALUES ($1, $2, $2, 'US', $3, $4, $5, $5)`,
          [id, slug, merchant, merchant === null ? null : T, T],
        );
      await add('pub_h', 'harbour-ledger', 'SBXMOWNERBUSINESS');
      await add('pub_n', 'northfield-quarterly', null);
      const before = (await d.query('SELECT * FROM publishers ORDER BY id')).rows;

      // 0011 (DP-2a) and 0012 (PUB-A1) exist now, so migrating the 0009 copy applies all three, in
      // order; the 0010 checks below are unchanged.
      // later migrations keep landing, so only the head of the applied list is pinned
      const appliedNow = await migrate(d, clock);
      expect(appliedNow.slice(0, 5)).toEqual([
        '0010_publisher_payee_shared',
        '0011_provider_order_state',
        '0012_publisher_side',
        '0013_publisher_applicants',
        '0014_publisher_visits',
      ]);
      const after = await d.query<Record<string, unknown>>('SELECT * FROM publishers ORDER BY id');
      // every old column value is kept; the new column is false for every existing row
      // 0012 (PUB-A1) also adds publishers.status, which is 'active' for every existing row
      expect(
        after.rows.map(({ payee_shared, ...rest }) => ({ ...rest, flag: payee_shared })),
      ).toEqual(before.map((r) => ({ ...r, status: 'active', flag: false })));
      // the old uniqueness still holds for these rows (nothing is flagged)
      await expect(add('pub_dup', 'dup', 'SBXMOWNERBUSINESS')).rejects.toThrow();
      // forward-only: there is no down step and a second run is a no-op
      expect(await migrate(d, clock)).toEqual([]);
      expect(
        readdirSync(common).filter((n) => /^0010_.+\.sql$/.test(n) && /down|rollback/i.test(n)),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('0010 payee guard hardening (DP-1 review M1, L1)', () => {
  const pubSql = (n: number, shared: boolean) =>
    `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, payee_verified_at, payee_shared, created_at, updated_at)
     VALUES ('pub_h${n}', 'ph${n}', 'P', 'US', 'SBXPAYEEHARD1', '${T}', ${shared}, '${T}', '${T}')`;

  it('the function definition is SECURITY DEFINER, pins pg_catalog, pg_temp and names public.publishers', async () => {
    const f = await db.query<{ def: string; secdef: boolean; config: string[] | null }>(
      `SELECT pg_get_functiondef(p.oid) AS def, p.prosecdef AS secdef, p.proconfig AS config
         FROM pg_proc p WHERE p.proname = 'ums_publisher_payee_guard'`,
    );
    expect(f.rows).toHaveLength(1);
    const { def, secdef, config } = f.rows[0]!;
    expect(secdef).toBe(true);
    expect(config).toEqual(['search_path=pg_catalog, pg_temp']);
    expect(def).toContain('public.publishers');
    expect(def).not.toMatch(/FROM\s+publishers\b/);
  });

  it('a temporary table named publishers does not shadow the real one (flagged row, then unflagged clash)', async () => {
    await db.query(pubSql(1, true));
    let created = true;
    try {
      await db.exec(
        'CREATE TEMP TABLE publishers (id text, paypal_merchant_id text, payee_shared boolean)',
      );
    } catch {
      created = false; // the driver refuses temp tables: the static test above carries the proof
    }
    try {
      // `publishers` now names the temp table first on the session path; the insert goes to the real one.
      await expect(
        db.query(pubSql(2, false).replace('INTO publishers', 'INTO public.publishers')),
      ).rejects.toThrow();
    } finally {
      if (created) await db.exec('DROP TABLE pg_temp.publishers');
    }
    const n = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.publishers');
    expect(n.rows[0]!.n).toBe(1);
  });

  it('a REPEATABLE READ writer of a merchant id is refused with serialization_failure', async () => {
    let code: unknown;
    try {
      await db.exec(`BEGIN ISOLATION LEVEL REPEATABLE READ; ${pubSql(1, true)};`);
    } catch (e) {
      code = (e as { code?: unknown }).code;
    } finally {
      await db.exec('ROLLBACK');
    }
    expect(code).toBe('40001');
    expect((await db.query('SELECT id FROM publishers')).rows).toEqual([]);
    // READ COMMITTED (the default) and SERIALIZABLE are fine
    await db.exec(`BEGIN ISOLATION LEVEL SERIALIZABLE; ${pubSql(1, true)}; COMMIT;`);
    expect((await db.query('SELECT id FROM publishers')).rows).toHaveLength(1);
  });
});
