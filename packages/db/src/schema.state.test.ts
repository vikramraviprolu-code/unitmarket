import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, migrate, openDatabase, resetDatabase, tablesInDependencyOrder } from './index';
import type { Database } from './temp-contracts-f1';

const T = '2026-10-21T10:00:00Z';
const T2 = '2026-10-21T11:00:00Z';
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
  await ins('publishers', { id: 'pub_1', slug: 'p1', display_name: 'Pub One', country: 'US', paypal_merchant_id: 'MERCH1', payee_verified_at: T });
  await ins('articles', {
    id: 'art_1', publisher_id: 'pub_1', title: 't', abstract: 'a', language: 'en', topics: ['x', 'y'],
    published_at: T, sha256: HASH, content_key: 'k1', bytes: 10, mime: 'text/plain',
  });
  await ins('buyers', { id: 'buy_1', display_name: 'B', auth_subject: 'sub1', country: 'US' });
}
async function approval(n: number, over: Record<string, unknown> = {}) {
  await ins('approvals', {
    id: `apr_${n}`, buyer_id: 'buy_1', snapshot: j({ v: 1 }), content_hash: HASH, nonce: `nonce${n}`,
    expires_at: T2, used_at: null, environment: 'dryrun', ...over,
  });
}
async function order(n: number, over: Record<string, unknown> = {}) {
  await approval(n);
  await ins('orders', {
    id: `ord_${n}`, approval_id: `apr_${n}`, buyer_id: 'buy_1', content_hash: HASH, order_ref: `ref_${n}`,
    expected: j({}), status: 'created', mismatch: false, corridor_id: 'us-usd', currency: 'USD',
    total_minor: 500, environment: 'dryrun', ...over,
  });
}
async function unit(n: number, orderN: number, over: Record<string, unknown> = {}) {
  await ins('order_units', {
    id: `unt_${n}`, order_id: `ord_${orderN}`, provider_order_ref: null, publisher_id: 'pub_1',
    reference_id: `refid_${n}`, payee_merchant_id: 'MERCH1', amount_minor: 500, platform_fee_minor: 0,
    capture_id: null, status: 'expected', status_reason: null, paypal_fee_minor: null, refunded_minor: 0,
    captured_verified_at: null, mismatch_reason: null, ...over,
  });
}
async function ledger(n: number, over: Record<string, unknown> = {}) {
  await ins('ledger_entries', {
    id: `led_${n}`, unit_id: 'unt_1', capture_id: 'CAP1', kind: 'sale', amount_minor: 500, currency: 'USD',
    refund_id: null, ref_entry_id: null, environment: 'dryrun', ...over,
  });
}
async function entitlement(n: number, over: Record<string, unknown> = {}) {
  await ins('entitlements', {
    id: `ent_${n}`, buyer_id: 'buy_1', article_id: 'art_1', unit_id: 'unt_1', option: 'keep_retrieve',
    policy: j({}), money_state: 'captured', access_state: 'locked', licence_state: 'granted',
    transition_log: j([]), environment: 'dryrun', ...over,
  });
}

beforeEach(async () => {
  db = await fresh();
});

describe('migrations', () => {
  it('migrations apply on a fresh PGlite and again as a no-op', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toEqual(['0001_core', '0002_buyers', '0003_entry', '0004_money', '0005_access', '0006_platform']);
    expect(await migrate(d, clock)).toEqual([]);
    const rows = await d.query<{ version: string; applied_at: Date | string }>('SELECT version, applied_at FROM schema_migrations ORDER BY version');
    expect(rows.rows).toHaveLength(6);
    expect(new Date(rows.rows[0]!.applied_at as string).toISOString()).toBe('2026-10-21T10:00:00.000Z');
  });
  it('a failing migration rolls back its own file only', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const dir = mkdtempSync(join(tmpdir(), 'ums-mig-'));
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE ok_t (id text PRIMARY KEY);');
      writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE bad_t (id text PRIMARY KEY); SELECT 1/0;');
      await expect(applyMigrations(d, clock, dir)).rejects.toThrow();
      expect((await d.query("SELECT to_regclass('ok_t') AS t")).rows[0]).toEqual({ t: 'ok_t' });
      expect((await d.query("SELECT to_regclass('bad_t') AS t")).rows[0]).toEqual({ t: null });
      expect((await d.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: '0001_ok' }]);
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
      expect(sql, f).not.toMatch(/current_timestamp|clock_timestamp|statement_timestamp|transaction_timestamp/i);
      expect(sql, f).not.toMatch(/\bDEFAULT\b/i);
      expect(sql, f).not.toMatch(/CREATE\s+EXTENSION/i);
    }
  });
  it('seeds the safety switches, the us-usd corridor and the two access policies', async () => {
    const sw = await db.query<{ name: string; on: boolean }>('SELECT name, "on" FROM safety_switches ORDER BY name');
    expect(sw.rows.map((r) => r.name)).toEqual([
      'ai_enabled', 'checkout_enabled', 'paypal_outbound', 'refunds_enabled', 'unlock_enabled', 'webhook_enabled',
    ]);
    expect(sw.rows.find((r) => r.name === 'paypal_outbound')!.on).toBe(false);
    const c = await db.query<{ id: string; currency: string; enabled: boolean }>('SELECT id, currency, enabled FROM corridors');
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
    for (const r of t.rows) {
      expect(r.cols, r.table_name).toContain('created_at');
      expect(r.cols, r.table_name).toContain('updated_at');
    }
    const defaults = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_default IS NOT NULL AND table_name <> 'schema_migrations'`,
    );
    expect(defaults.rows).toEqual([]);
  });
  it('ums_id refuses blank, padded and control-character ids', async () => {
    for (const bad of ['', ' x', 'x ', 'a\nb', 'a​b']) {
      await expect(ins('buyers', { id: bad, display_name: 'B', auth_subject: `s-${bad.length}`, country: 'US' })).rejects.toThrow();
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
    await ins('receipts', { id: 'rct_1', order_id: 'ord_1', version: 1, body: j({}), sha256: HASH, environment: 'dryrun' });
    await ins('provider_calls', {
      id: 'pcl_1', operation_id: null, operation: 'create_order', method: 'POST', path_template: '/v2/checkout/orders',
      http_status: 201, outcome: 'ok', debug_id: null, duration_ms: 5, transport_kind: 'dryrun',
      request_redacted: j({}), response_redacted: j({}), environment: 'dryrun',
    });
    await ins('access_events', {
      id: 'aev_1', entitlement_id: 'ent_1', kind: 'access_ready', at: T, source: 'system', evidence: j({}), environment: 'dryrun',
    });
    await ins('audit_log', { id: 'aud_1', actor_kind: 'system', actor_id: null, action: 'x', target: null, reason: null, detail: j({}) });
    await ins('outbound_approvals', {
      id: 'oap_1', approval_ref: 'ref1', scope: 'sandbox', operations: ['create_order'], max_amount_minor: 100,
      max_calls_per_day: 10, valid_until: T2, approved_by: 'owner',
    });
  }
  const TABLES = ['ledger_entries', 'receipts', 'provider_calls', 'access_events', 'audit_log', 'outbound_approvals'];

  it('UPDATE and DELETE on ledger_entries, receipts, provider_calls, access_events, audit_log, outbound_approvals raise', async () => {
    await seedAppendOnly();
    for (const t of TABLES) {
      await expect(db.query(`UPDATE ${t} SET updated_at = $1`, [T2]), `${t} update`).rejects.toThrow(/append-only/);
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
    expect((await db.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0]).toEqual({ n: 1 });
    await expect(db.exec("SELECT set_config('ums.allow_reset', 'off', true); TRUNCATE ledger_entries")).rejects.toThrow();
  });
  it('resetDatabase empties everything, keeps schema_migrations, and leaves the guard armed', async () => {
    await seedAppendOnly();
    await resetDatabase(db);
    for (const t of TABLES) expect((await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]).toEqual({ n: 0 });
    expect((await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0]).toEqual({ n: 6 });
    await expect(db.exec('TRUNCATE ledger_entries')).rejects.toThrow();
  });
  it('approvals: only used_at may be set, once; delete refused', async () => {
    await base();
    await approval(1);
    await expect(db.query("UPDATE approvals SET nonce = 'zzz' WHERE id = 'apr_1'")).rejects.toThrow();
    await expect(db.query(`UPDATE approvals SET content_hash = $1 WHERE id = 'apr_1'`, [HASH2])).rejects.toThrow();
    await expect(db.query(`UPDATE approvals SET snapshot = '{"v":2}' WHERE id = 'apr_1'`)).rejects.toThrow();
    await expect(db.query(`UPDATE approvals SET expires_at = $1 WHERE id = 'apr_1'`, [T])).rejects.toThrow();
    await db.query(`UPDATE approvals SET used_at = $1 WHERE id = 'apr_1'`, [T2]);
    await expect(db.query(`UPDATE approvals SET used_at = $1 WHERE id = 'apr_1'`, [T])).rejects.toThrow();
    await expect(db.query(`UPDATE approvals SET used_at = NULL WHERE id = 'apr_1'`)).rejects.toThrow();
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
    for (const [i, s] of ['created', 'awaiting_buyer', 'capture_requested', 'capture_claimed', 'unresolved', 'frozen'].entries()) {
      await ins('buyers', { id: `buy_s${i}`, display_name: 'B', auth_subject: `ss${i}`, country: 'US' });
      await approval(10 + i, { buyer_id: `buy_s${i}` });
      await ins('orders', {
        id: `ord_s${i}`, approval_id: `apr_${10 + i}`, buyer_id: `buy_s${i}`, content_hash: HASH, order_ref: `rs${i}`,
        expected: j({}), status: s, mismatch: false, corridor_id: 'us-usd', currency: 'USD', total_minor: 1, environment: 'dryrun',
      });
    }
  });
  it('approval id is unique per order', async () => {
    await base();
    await order(1);
    await expect(
      ins('orders', {
        id: 'ord_9', approval_id: 'apr_1', buyer_id: 'buy_1', content_hash: HASH2, order_ref: 'ref_9', expected: j({}),
        status: 'created', mismatch: false, corridor_id: 'us-usd', currency: 'USD', total_minor: 1, environment: 'dryrun',
      }),
    ).rejects.toThrow();
  });
  it('orders currency must equal the corridor currency', async () => {
    await base();
    await expect(order(1, { currency: 'EUR' })).rejects.toThrow(/corridor|currency/i);
    await order(2);
    await expect(db.query("UPDATE orders SET currency = 'EUR' WHERE id = 'ord_2'")).rejects.toThrow(/corridor|currency/i);
    await expect(order(3, { corridor_id: 'nope' })).rejects.toThrow();
  });
  it('capture_id unique across units, many null capture ids allowed', async () => {
    await base();
    await order(1);
    await unit(1, 1);
    await unit(2, 1);
    await db.query("UPDATE order_units SET capture_id = 'CAP1' WHERE id = 'unt_1'");
    await expect(db.query("UPDATE order_units SET capture_id = 'CAP1' WHERE id = 'unt_2'")).rejects.toThrow(/duplicate key|unique/i);
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
    for (const [i, s] of ['captured_verified', 'pending', 'declined', 'mismatch', 'partially_refunded', 'refunded', 'reversal_suspected', 'reversed'].entries()) {
      await unit(20 + i, 1, { status: s });
    }
  });
  it('ledger refuses a second (capture, refund, kind)', async () => {
    await base();
    await order(1);
    await unit(1, 1);
    await ledger(1);
    await expect(ledger(2)).rejects.toThrow(/duplicate key|unique/i);
    await ledger(3, { kind: 'refund', refund_id: 'RF1', amount_minor: 100 });
    await expect(ledger(4, { kind: 'refund', refund_id: 'RF1', amount_minor: 100 })).rejects.toThrow(/duplicate key|unique/i);
    await ledger(5, { kind: 'refund', refund_id: 'RF2', amount_minor: 50 });
    await ledger(6, { kind: 'paypal_fee', amount_minor: 30 });
    await expect(ledger(7, { kind: 'mystery' })).rejects.toThrow();
  });
  it('operations: kind, state and the lease, unknown and failed rules', async () => {
    await base();
    await order(1);
    const op = (n: number, over: Record<string, unknown>) =>
      ins('operations', {
        id: `opr_${n}`, order_id: 'ord_1', unit_id: null, kind: 'create', state: 'prepared', attempt: 0, request_id: `umsC-${n}`,
        first_sent_at: null, idem_safe_until: null, lease_until: T2, next_retry_at: null, reconcile_until: null, failure_reason: null, ...over,
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
    for (const [i, k] of ['capture', 'readback', 'refund', 'refund_readback'].entries()) await op(20 + i, { kind: k });
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
        id: 'pcl_x', operation_id: null, operation: 'create_order', method: 'POST', path_template: '/p', http_status: null,
        outcome: 'ok', debug_id: null, duration_ms: 1, transport_kind: 'live', request_redacted: j({}), response_redacted: j({}), environment: 'dryrun',
      }),
    ).rejects.toThrow();
    await expect(
      ins('webhook_events', {
        id: 'whk_1', event_id: 'e1', transmission_id: 't1', type: 'OTHER', verified: true, outcome: null, resource: j({}),
        received_at: T, applied_at: null, environment: 'live',
      }),
    ).rejects.toThrow();
    await expect(
      ins('receipts', { id: 'rct_x', order_id: 'ord_3', version: 1, body: j({}), sha256: HASH, environment: 'live' }),
    ).rejects.toThrow();
  });
  it('webhook event id and transmission id are unique', async () => {
    const w = (n: number, over: Record<string, unknown> = {}) =>
      ins('webhook_events', {
        id: `whk_${n}`, event_id: `e${n}`, transmission_id: `t${n}`, type: 'OTHER', verified: true, outcome: null, resource: j({}),
        received_at: T, applied_at: null, environment: 'sandbox', ...over,
      });
    await w(1);
    await expect(w(2, { event_id: 'e1' })).rejects.toThrow(/duplicate key|unique/i);
    await expect(w(3, { transmission_id: 't1' })).rejects.toThrow(/duplicate key|unique/i);
  });
  it('receipt version is unique per order', async () => {
    await base();
    await order(1);
    const r = (n: number, v: number) => ins('receipts', { id: `rct_${n}`, order_id: 'ord_1', version: v, body: j({}), sha256: HASH, environment: 'dryrun' });
    await r(1, 1);
    await expect(r(2, 1)).rejects.toThrow(/duplicate key|unique/i);
    await r(3, 2);
  });
  it('provider_order id unique, route checked', async () => {
    await base();
    await order(1);
    const p = (n: number, over: Record<string, unknown> = {}) =>
      ins('provider_orders', { id: `pvo_${n}`, order_id: 'ord_1', provider_order_id: `PP${n}`, route: 'single', approve_url: null, status: null, ...over });
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
    await expect(entitlement(1, { access_state: 'available', money_state: 'pending', licence_state: null })).rejects.toThrow();
    await expect(entitlement(2, { access_state: 'available', money_state: 'refunded', licence_state: 'terminated' })).rejects.toThrow();
    await entitlement(3, { access_state: 'available', money_state: 'captured', licence_state: 'granted' });
  });
  it('licence is set exactly when money is captured, refunded or reversed', async () => {
    await base();
    await order(1);
    await unit(1, 1);
    await expect(entitlement(1, { money_state: 'captured', licence_state: null })).rejects.toThrow();
    await expect(entitlement(2, { money_state: 'pending', licence_state: 'granted' })).rejects.toThrow();
    await expect(entitlement(3, { money_state: 'unknown', licence_state: 'granted' })).rejects.toThrow();
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
      ins('access_windows', { entitlement_id: 'ent_1', state: 'not_started', started_at: null, base_ends_at: null, ends_at: null, paused_at: null, credit_ms: 0, ...over });
    await expect(w({ credit_ms: -1 })).rejects.toThrow();
    await expect(w({ state: 'bogus' })).rejects.toThrow();
    await w({});
    await expect(w({})).rejects.toThrow();
  });
  it('delivery evidence is unique per (link_id, kind) when a link is present', async () => {
    await base();
    await order(1);
    await unit(1, 1);
    await entitlement(1);
    await ins('links', { id: 'lnk_1', entitlement_id: 'ent_1', buyer_id: 'buy_1', token_hash: HASH, expires_at: T2, uses: 0 });
    const ev = (n: number, over: Record<string, unknown>) =>
      ins('access_events', { id: `aev_${n}`, entitlement_id: 'ent_1', kind: 'download_completed', at: T, source: 'buyer', evidence: j({}), link_id: 'lnk_1', environment: 'dryrun', ...over });
    await ev(1, {});
    await expect(ev(2, {})).rejects.toThrow(/duplicate key|unique/i);
    await ev(3, { kind: 'download_aborted' });
    await ev(4, { link_id: null });
    await ev(5, { link_id: null });
    await expect(ev(6, { kind: 'nonsense', link_id: null })).rejects.toThrow();
    await expect(ins('links', { id: 'lnk_2', entitlement_id: 'ent_1', buyer_id: 'buy_1', token_hash: HASH, expires_at: T2, uses: 0 })).rejects.toThrow();
  });
});

describe('platform constraints', () => {
  it('alerts: one per kind, order, unit and reason; NULLs compare equal', async () => {
    await base();
    await order(1);
    const a = (n: number, over: Record<string, unknown>) =>
      ins('alerts', { id: `alr_${n}`, kind: 'order_mismatch', order_id: 'ord_1', unit_id: null, detail: j({ reason: 'amount' }), ...over });
    await a(1, {});
    await expect(a(2, {})).rejects.toThrow(/duplicate key|unique/i);
    await a(3, { detail: j({ reason: 'payee' }) });
    await a(4, { detail: j({}) });
    await expect(a(5, { detail: j({}) })).rejects.toThrow(/duplicate key|unique/i);
  });
  it('api_idempotency is unique per (actor_kind, actor_id, key)', async () => {
    const k = (n: number, over: Record<string, unknown> = {}) =>
      ins('api_idempotency', { id: `idk_${n}`, key: 'K1', actor_kind: 'buyer', actor_id: 'buy_1', route: 'POST /api/orders', request_sha256: HASH, response: j({}), ...over });
    await k(1);
    await expect(k(2)).rejects.toThrow(/duplicate key|unique/i);
    await k(3, { actor_id: 'buy_2' });
    await k(4, { key: 'K2' });
  });
  it('recovery case kind and state are checked', async () => {
    const c = (n: number, over: Record<string, unknown>) =>
      ins('recovery_cases', {
        id: `cas_${n}`, kind: 'delivery_failed', state: 'open', order_id: null, entitlement_id: null, buyer_id: null,
        opened_by: 'system', sla_due_at: T2, credit_ms: 0, buyer_message: 'm', ...over,
      });
    await c(1, {});
    await expect(c(2, { kind: 'x' })).rejects.toThrow();
    await expect(c(3, { state: 'x' })).rejects.toThrow();
    await expect(c(4, { credit_ms: -5 })).rejects.toThrow();
  });
  it('recovery_actions are append-only', async () => {
    await ins('recovery_cases', {
      id: 'cas_1', kind: 'delivery_failed', state: 'open', order_id: null, entitlement_id: null, buyer_id: null,
      opened_by: 'system', sla_due_at: T2, credit_ms: 0, buyer_message: 'm',
    });
    await ins('recovery_actions', { id: 'rca_1', case_id: 'cas_1', action: 'note', actor: 'op', detail: j({}), at: T });
    await expect(db.query("UPDATE recovery_actions SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM recovery_actions')).rejects.toThrow(/append-only/);
    await expect(db.exec('TRUNCATE recovery_actions')).rejects.toThrow();
  });
  it('catalogue: offers and policies are versioned; publisher authorisations are append-only', async () => {
    await base();
    const o = (v: string) =>
      ins('offers', {
        id: 'ofr_1', version: v, publisher_id: 'pub_1', article_id: 'art_1', status: 'authorised', currency: 'USD', options: j([]),
        affordability: j({}), terms_version: 't1', rights: j({}), valid_from: T, valid_until: null, superseded_by: null,
      });
    await o('1');
    await o('2');
    await expect(o('2')).rejects.toThrow();
    await ins('publisher_authorisations', { id: 'pau_1', offer_id: 'ofr_1', offer_version: '2', authorised_by: 'pub_1', at: T });
    await expect(ins('publisher_authorisations', { id: 'pau_2', offer_id: 'ofr_1', offer_version: '9', authorised_by: 'pub_1', at: T })).rejects.toThrow();
    await expect(db.query("UPDATE publisher_authorisations SET authorised_by = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM publisher_authorisations')).rejects.toThrow(/append-only/);
    await expect(
      ins('access_policies', { id: 'keep_retrieve', version: '1', option: 'keep_retrieve', window_ms: 1, start_rule: 'payment_verified_and_delivery_ready' }),
    ).rejects.toThrow();
  });
  it('quotes reference an offer version and a corridor', async () => {
    await base();
    await ins('offers', {
      id: 'ofr_1', version: '1', publisher_id: 'pub_1', article_id: 'art_1', status: 'authorised', currency: 'USD', options: j([]),
      affordability: j({}), terms_version: 't1', rights: j({}), valid_from: T, valid_until: null, superseded_by: null,
    });
    const q = (n: number, over: Record<string, unknown> = {}) =>
      ins('quotes', { id: `quo_${n}`, buyer_id: null, offer_id: 'ofr_1', offer_version: '1', option: 'keep_retrieve', price_minor: 100, currency: 'USD', corridor_id: 'us-usd', source: 'direct', expires_at: T2, ...over });
    await q(1);
    await expect(q(2, { offer_version: '7' })).rejects.toThrow();
    await expect(q(3, { corridor_id: 'zz' })).rejects.toThrow();
    await expect(q(4, { source: 'x' })).rejects.toThrow();
  });
  it('rate bucket and safety switch use their natural key', async () => {
    await ins('rate_buckets', { bucket_key: 'ip:1', tokens: 5, refilled_at: T });
    await expect(ins('rate_buckets', { bucket_key: 'ip:1', tokens: 5, refilled_at: T })).rejects.toThrow();
    await expect(ins('safety_switches', { name: 'paypal_outbound', on: false, changed_by: 'x', changed_at: T, reason: 'r' })).rejects.toThrow();
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
    for (const r of fks.rows) expect(pos(r.parent), `${r.parent} before ${r.child}`).toBeLessThan(pos(r.child));
    expect(order_).not.toContain('schema_migrations');
    expect(new Set(order_).size).toBe(order_.length);
    expect(order_.slice().sort()).toEqual(
      (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY tablename")).rows.map((r) => r.tablename),
    );
  });
});

describe('drivers', () => {
  it('pglite-disk survives close and reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ums-disk-'));
    try {
      const a = await openDatabase({ kind: 'pglite-disk', dir });
      await migrate(a, clock);
      await a.query("INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ('buy_d', 'D', 'sd', 'US', $1, $1)", [T]);
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
      await tx.query("INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ('buy_t', 'T', 'st', 'US', $1, $1)", [T]);
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ('buy_u', 'U', 'su', 'US', $1, $1)", [T]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await db.query('SELECT id FROM buyers ORDER BY id')).rows).toEqual([{ id: 'buy_t' }]);
    expect(db.dialect).toBe('pglite');
  });
});
