// Test support for the INT-TR0 journal suites (not a test, never imported by product code). One
// migrated in-memory database, a context builder, and a world: one row in every tracked table, built in
// foreign-key order, each step with the chain it must land on and one update that changes a copied
// column. The expectations here are written by hand from the spec table, not read from the migration.
import type { Clock, Database, SqlExecutor, TraceContext } from '@umsbx/contracts';
import { migrate, openDatabase } from './index';
import type { SqlDriver } from './driver';
import { withTraceDb } from './trace-db';

export const T = '2026-11-04T10:00:00Z';
export const T2 = '2026-11-04T11:00:00Z';
export const T3 = '2026-11-04T12:00:00Z';
export const T15 = '2026-11-04T10:15:00Z'; // approval expires_at = created_at + 15 minutes
export const HASH = 'a'.repeat(64);
export const HASH2 = 'b'.repeat(64);
export const clock: Clock = { now: () => new Date(T2) };

export type Db = SqlDriver;

export async function freshDb(): Promise<Db> {
  const d = await openDatabase({ kind: 'pglite-memory' });
  await migrate(d, { now: () => new Date(T) });
  return d;
}

let ctxCounter = 0;
/** A context a request would open. Every call is a new context id. */
export function ctx(over: Partial<TraceContext> = {}): TraceContext {
  ctxCounter += 1;
  return {
    id: `ctx_test_${String(ctxCounter).padStart(6, '0')}`,
    at: T,
    channel: 'web',
    actor_kind: 'operator',
    actor_id: 'opr_test',
    on_behalf_of: null,
    mandate_id: null,
    mfa: true,
    req_id: `req_test_${ctxCounter}`,
    ip_hash: 'f'.repeat(32),
    ua_family: 'browser',
    api_key_id: null,
    job: null,
    tool: null,
    ...over,
  };
}

/** The database as the app sees it with a context open: every write is attributed to `c`. */
export function as<T extends Database>(db: T, c: TraceContext | undefined, clk: Clock = clock): T {
  return withTraceDb(db, () => c, clk);
}

export const j = (v: unknown): string => JSON.stringify(v);

export async function ins(
  db: SqlExecutor,
  table: string,
  row: Record<string, unknown>,
  withTimes = true,
): Promise<void> {
  let r: Record<string, unknown> = withTimes ? { created_at: T, updated_at: T, ...row } : row;
  // alerts_one_per_kind: one open alert per (kind, order, unit, reason). Give each test alert its own reason.
  if (table === 'alerts' && typeof r['detail'] === 'string') {
    const d = JSON.parse(r['detail']) as Record<string, unknown>;
    if (d['reason'] === undefined) r = { ...r, detail: JSON.stringify({ ...d, reason: r['id'] }) };
  }
  const cols = Object.keys(r);
  await db.query(
    `INSERT INTO ${table} (${cols.map((c) => (c === 'on' ? '"on"' : c)).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}

export interface EventRow {
  chain_key: string;
  seq: number;
  prev_hash: string;
  row_hash: string;
  occurred_at: string;
  actor_kind: string;
  actor_id: string | null;
  on_behalf_of: string | null;
  mandate_id: string | null;
  mfa: boolean;
  ctx_id: string | null;
  channel: string | null;
  event_type: string;
  source_table: string;
  source_id: string;
  order_id: string | null;
  unit_id: string | null;
  mandate_ref: string | null;
  publisher_id: string | null;
  buyer_id: string | null;
  body: {
    op: string;
    n: number;
    cols: Record<string, [unknown, unknown]>;
    hashed: Record<string, [unknown, unknown]>;
    source_digest?: string;
  };
}

const EVENT_SELECT = `SELECT chain_key, seq::int AS seq, prev_hash, row_hash,
  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at,
  actor_kind, actor_id, on_behalf_of, mandate_id, mfa, ctx_id, channel, event_type, source_table,
  source_id, order_id, unit_id, mandate_ref, publisher_id, buyer_id, body FROM trace_events`;

export async function eventsOf(db: SqlExecutor, table: string, id: string): Promise<EventRow[]> {
  const r = await db.query<EventRow>(
    `${EVENT_SELECT} WHERE source_table = $1 AND source_id = $2 ORDER BY (body->>'n')::int, chain_key, seq`,
    [table, id],
  );
  return r.rows;
}

export async function chainOf(db: SqlExecutor, chain: string): Promise<EventRow[]> {
  const r = await db.query<EventRow>(`${EVENT_SELECT} WHERE chain_key = $1 ORDER BY seq`, [chain]);
  return r.rows;
}

export async function allEvents(db: SqlExecutor): Promise<EventRow[]> {
  const r = await db.query<EventRow>(`${EVENT_SELECT} ORDER BY chain_key, seq`);
  return r.rows;
}

export async function countEvents(db: SqlExecutor): Promise<number> {
  return (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM trace_events')).rows[0]!.n;
}

/** A step of the world: one insert into one tracked table and the chain that insert must land on. */
export interface Step {
  table: string;
  id: string;
  chain: string;
  /** Subject keys the event must carry (spec: order_id, unit_id, mandate_ref, publisher_id, buyer_id). */
  subject?: Partial<
    Pick<EventRow, 'order_id' | 'unit_id' | 'mandate_ref' | 'publisher_id' | 'buyer_id'>
  >;
  /** Absent for the seven migration-seeded safety switches. */
  insert?: (db: SqlExecutor) => Promise<void>;
  /** Copied columns the insert event must hold as [null, value]. */
  insertCols?: Record<string, unknown>;
  /** Columns that must be stored only as sha256 hex. */
  insertHashed?: string[];
  /** An update that changes one copied (or hashed) column. */
  update?: { sql: string; params?: unknown[]; col: string; before: unknown; after: unknown };
  /** An update that changes only columns outside the allow-list: it must write no event. */
  untracked?: { sql: string; params?: unknown[] };
}

const pubRow = {
  id: 'pub_1',
  slug: 'p1',
  display_name: 'Pub One',
  country: 'US',
  paypal_merchant_id: 'MERCH1',
  payee_verified_at: T,
};

export const STEPS: Step[] = [
  {
    table: 'publishers',
    id: 'pub_1',
    chain: 'pub:pub_1',
    subject: { publisher_id: 'pub_1' },
    insert: async (db) => {
      await ins(db, 'publishers', pubRow);
      await ins(db, 'publishers', {
        id: 'pub_2',
        slug: 'p2',
        display_name: 'Pub Two',
        country: 'US',
        paypal_merchant_id: null,
        payee_verified_at: null,
        status: 'applied',
      });
      // Untracked prerequisites: the article, two buyers.
      await ins(db, 'articles', {
        id: 'art_1',
        publisher_id: 'pub_1',
        title: 't',
        abstract: 'a',
        language: 'en',
        topics: ['x'],
        published_at: T,
        sha256: HASH,
        content_key: 'k1',
        bytes: 10,
        mime: 'text/plain',
      });
      await ins(db, 'buyers', {
        id: 'buy_1',
        display_name: 'B',
        auth_subject: 'sub1',
        country: 'US',
      });
      await ins(db, 'buyers', {
        id: 'buy_2',
        display_name: 'B2',
        auth_subject: 'sub2',
        country: 'US',
      });
    },
    insertCols: {
      status: 'active',
      payee_verified_at: '2026-11-04T10:00:00+00:00',
      payee_shared: false,
    },
    insertHashed: ['paypal_merchant_id'],
    update: {
      sql: `UPDATE publishers SET status = 'suspended', updated_at = '${T2}' WHERE id = 'pub_1'`,
      col: 'status',
      before: 'active',
      after: 'suspended',
    },
    untracked: { sql: `UPDATE publishers SET display_name = 'Pub One b' WHERE id = 'pub_1'` },
  },
  {
    table: 'offers',
    id: 'ofr_1:v1',
    chain: 'pub:pub_1',
    subject: { publisher_id: 'pub_1' },
    insert: (db) =>
      ins(db, 'offers', {
        id: 'ofr_1',
        version: 'v1',
        publisher_id: 'pub_1',
        article_id: 'art_1',
        status: 'draft',
        currency: 'USD',
        options: j([]),
        affordability: j({}),
        terms_version: 't1',
        rights: j({}),
        valid_from: T,
      }),
    insertCols: { status: 'draft' },
    update: {
      sql: `UPDATE offers SET status = 'authorised', updated_at = '${T2}' WHERE id = 'ofr_1'`,
      col: 'status',
      before: 'draft',
      after: 'authorised',
    },
    untracked: { sql: `UPDATE offers SET terms_version = 't2' WHERE id = 'ofr_1'` },
  },
  {
    table: 'approvals',
    id: 'apr_1',
    chain: 'buy:buy_1',
    subject: { buyer_id: 'buy_1' },
    insert: (db) =>
      ins(db, 'approvals', {
        id: 'apr_1',
        buyer_id: 'buy_1',
        snapshot: j({ v: 1, note: 'CANARY-SNAPSHOT' }),
        content_hash: HASH,
        nonce: 'nonce1',
        expires_at: T15,
        used_at: null,
        environment: 'dryrun',
      }),
    insertCols: { content_hash: HASH, used_at: null, environment: 'dryrun' },
    insertHashed: ['snapshot'],
    update: {
      sql: `UPDATE approvals SET used_at = '2026-11-04T10:05:00Z', updated_at = '${T2}' WHERE id = 'apr_1'`,
      col: 'used_at',
      before: null,
      after: '2026-11-04T10:05:00+00:00',
    },
  },
  {
    table: 'orders',
    id: 'ord_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1', buyer_id: 'buy_1' },
    insert: (db) =>
      ins(db, 'orders', {
        id: 'ord_1',
        approval_id: 'apr_1',
        buyer_id: 'buy_1',
        content_hash: HASH,
        order_ref: 'ref_1',
        expected: j({ lines: [] }),
        status: 'created',
        mismatch: false,
        corridor_id: 'us-usd',
        currency: 'USD',
        total_minor: 500,
        environment: 'dryrun',
      }),
    insertCols: {
      status: 'created',
      total_minor: 500,
      currency: 'USD',
      corridor_id: 'us-usd',
      order_ref: 'ref_1',
      environment: 'dryrun',
    },
    insertHashed: ['expected'],
    update: {
      sql: `UPDATE orders SET status = 'awaiting_buyer', updated_at = '${T2}' WHERE id = 'ord_1'`,
      col: 'status',
      before: 'created',
      after: 'awaiting_buyer',
    },
    untracked: { sql: `UPDATE orders SET updated_at = '${T3}' WHERE id = 'ord_1'` },
  },
  {
    table: 'provider_orders',
    id: 'pvo_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1' },
    insert: (db) =>
      ins(db, 'provider_orders', {
        id: 'pvo_1',
        order_id: 'ord_1',
        provider_order_id: 'PPORDER1',
        route: 'single',
        approve_url: null,
        status: null,
        position: 1,
        po_ref: 'ref_1',
        publisher_id: null,
        state: 'prepared',
        first_approved_at: null,
      }),
    insertCols: { state: 'prepared', provider_order_id: 'PPORDER1', position: 1 },
    update: {
      sql: `UPDATE provider_orders SET state = 'awaiting_buyer', updated_at = '${T2}' WHERE id = 'pvo_1'`,
      col: 'state',
      before: 'prepared',
      after: 'awaiting_buyer',
    },
    untracked: {
      sql: `UPDATE provider_orders SET approve_url = NULL, updated_at = '${T3}' WHERE id = 'pvo_1'`,
    },
  },
  {
    table: 'order_units',
    id: 'unt_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1', unit_id: 'unt_1', publisher_id: 'pub_1' },
    insert: (db) =>
      ins(db, 'order_units', {
        id: 'unt_1',
        order_id: 'ord_1',
        provider_order_ref: null,
        publisher_id: 'pub_1',
        reference_id: 'refid_1',
        payee_merchant_id: 'MERCH1',
        amount_minor: 500,
        platform_fee_minor: 0,
        capture_id: 'CAP1',
        status: 'expected',
        status_reason: null,
        paypal_fee_minor: null,
        refunded_minor: 0,
        captured_verified_at: null,
        mismatch_reason: null,
      }),
    insertCols: { status: 'expected', amount_minor: 500, capture_id: 'CAP1', refunded_minor: 0 },
    insertHashed: ['payee_merchant_id'],
    update: {
      sql: `UPDATE order_units SET status = 'captured_verified', captured_verified_at = '${T2}', updated_at = '${T2}' WHERE id = 'unt_1'`,
      col: 'status',
      before: 'expected',
      after: 'captured_verified',
    },
    untracked: {
      sql: `UPDATE order_units SET provider_order_ref = NULL, updated_at = '${T3}' WHERE id = 'unt_1'`,
    },
  },
  {
    table: 'operations',
    id: 'opr_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1' },
    insert: (db) =>
      ins(db, 'operations', {
        id: 'opr_1',
        order_id: 'ord_1',
        unit_id: null,
        kind: 'create',
        state: 'confirmed',
        attempt: 1,
        request_id: 'reqid_1',
        first_sent_at: null,
        idem_safe_until: null,
        lease_until: null,
        next_retry_at: null,
        reconcile_until: null,
        failure_reason: null,
        provider_order_ref: null,
      }),
    insertCols: { kind: 'create', state: 'confirmed', attempt: 1, failure_reason: null },
    update: {
      sql: `UPDATE operations SET attempt = 2, updated_at = '${T2}' WHERE id = 'opr_1'`,
      col: 'attempt',
      before: 1,
      after: 2,
    },
    untracked: {
      sql: `UPDATE operations SET lease_until = '${T3}', next_retry_at = '${T3}', updated_at = '${T3}' WHERE id = 'opr_1'`,
    },
  },
  {
    table: 'provider_calls',
    id: 'pcl_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1' },
    insert: (db) =>
      ins(db, 'provider_calls', {
        id: 'pcl_1',
        operation_id: 'opr_1',
        operation: 'create_order',
        method: 'POST',
        path_template: '/v2/checkout/orders',
        http_status: 201,
        outcome: 'ok',
        debug_id: 'dbg1',
        duration_ms: 5,
        transport_kind: 'dryrun',
        request_redacted: j({ note: 'CANARY-CALL-REQUEST' }),
        response_redacted: j({ note: 'CANARY-CALL-RESPONSE' }),
        environment: 'dryrun',
      }),
    insertCols: {
      operation: 'create_order',
      method: 'POST',
      http_status: 201,
      outcome: 'ok',
      debug_id: 'dbg1',
      transport_kind: 'dryrun',
    },
    insertHashed: ['request_redacted', 'response_redacted'],
  },
  {
    table: 'webhook_events',
    id: 'whk_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1' },
    insert: (db) =>
      ins(db, 'webhook_events', {
        id: 'whk_1',
        event_id: 'EV1',
        transmission_id: 'TR1',
        type: 'PAYMENT.CAPTURE.COMPLETED',
        verified: true,
        outcome: null,
        resource: j({
          capture_id: 'CAP1',
          refund_id: null,
          provider_order_id: 'PPORDER1',
          occurred_at: T,
        }),
        received_at: T,
        applied_at: null,
        environment: 'dryrun',
      }),
    insertCols: {
      event_id: 'EV1',
      type: 'PAYMENT.CAPTURE.COMPLETED',
      verified: true,
      outcome: null,
    },
    insertHashed: ['resource'],
    update: {
      sql: `UPDATE webhook_events SET outcome = 'enqueued', updated_at = '${T2}' WHERE id = 'whk_1'`,
      col: 'outcome',
      before: null,
      after: 'enqueued',
    },
  },
  {
    table: 'refund_requests',
    id: 'rfr_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1', unit_id: 'unt_1' },
    insert: (db) =>
      ins(db, 'refund_requests', {
        id: 'rfr_1',
        unit_id: 'unt_1',
        capture_id: 'CAP1',
        amount_minor: 100,
        currency: 'USD',
        reason: 'CANARY-REFUND-REASON',
        requested_by: 'opr_test',
        state: 'requested',
        refund_id: null,
      }),
    insertCols: {
      amount_minor: 100,
      currency: 'USD',
      state: 'requested',
      capture_id: 'CAP1',
      requested_by: 'opr_test',
    },
    insertHashed: ['reason'],
    update: {
      sql: `UPDATE refund_requests SET state = 'completed', refund_id = 'RFD1', updated_at = '${T2}' WHERE id = 'rfr_1'`,
      col: 'state',
      before: 'requested',
      after: 'completed',
    },
  },
  {
    table: 'ledger_entries',
    id: 'led_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1', unit_id: 'unt_1' },
    insert: (db) =>
      ins(db, 'ledger_entries', {
        id: 'led_1',
        unit_id: 'unt_1',
        capture_id: 'CAP1',
        kind: 'sale',
        amount_minor: 500,
        currency: 'USD',
        refund_id: null,
        ref_entry_id: null,
        environment: 'dryrun',
      }),
    insertCols: { kind: 'sale', amount_minor: 500, currency: 'USD', capture_id: 'CAP1' },
  },
  {
    table: 'receipts',
    id: 'rct_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1' },
    insert: (db) =>
      ins(db, 'receipts', {
        id: 'rct_1',
        order_id: 'ord_1',
        version: 1,
        body: j({ lines: [], who: 'CANARY-RECEIPT-BODY' }),
        sha256: HASH,
        environment: 'dryrun',
      }),
    insertCols: { version: 1, sha256: HASH },
    insertHashed: ['body'],
  },
  {
    table: 'entitlements',
    id: 'ent_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1', unit_id: 'unt_1', buyer_id: 'buy_1' },
    insert: (db) =>
      ins(db, 'entitlements', {
        id: 'ent_1',
        buyer_id: 'buy_1',
        article_id: 'art_1',
        unit_id: 'unt_1',
        option: 'keep_retrieve',
        policy: j({ window_ms: 1000 }),
        money_state: 'captured',
        access_state: 'locked',
        licence_state: 'granted',
        transition_log: j([]),
        environment: 'dryrun',
      }),
    insertCols: {
      money_state: 'captured',
      access_state: 'locked',
      licence_state: 'granted',
      article_id: 'art_1',
      unit_id: 'unt_1',
    },
    insertHashed: ['option', 'policy'],
    update: {
      sql: `UPDATE entitlements SET access_state = 'available', updated_at = '${T2}' WHERE id = 'ent_1'`,
      col: 'access_state',
      before: 'locked',
      after: 'available',
    },
    untracked: {
      sql: `UPDATE entitlements SET transition_log = '[{"x":1}]'::jsonb, updated_at = '${T3}' WHERE id = 'ent_1'`,
    },
  },
  {
    table: 'access_windows',
    id: 'ent_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1' },
    insert: (db) =>
      ins(db, 'access_windows', {
        entitlement_id: 'ent_1',
        state: 'not_started',
        started_at: null,
        base_ends_at: null,
        ends_at: null,
        paused_at: null,
        credit_ms: 0,
      }),
    insertCols: { state: 'not_started', credit_ms: 0, started_at: null },
    update: {
      sql: `UPDATE access_windows SET state = 'running', started_at = '${T2}', base_ends_at = '${T3}', ends_at = '${T3}', updated_at = '${T2}' WHERE entitlement_id = 'ent_1'`,
      col: 'state',
      before: 'not_started',
      after: 'running',
    },
    untracked: {
      sql: `UPDATE access_windows SET base_ends_at = '${T2}', updated_at = '${T3}' WHERE entitlement_id = 'ent_1'`,
    },
  },
  {
    table: 'links',
    id: 'lnk_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1' },
    insert: (db) =>
      ins(db, 'links', {
        id: 'lnk_1',
        entitlement_id: 'ent_1',
        buyer_id: 'buy_1',
        token_hash: HASH2,
        expires_at: T15,
        uses: 0,
        session_id: null,
      }),
    insertCols: { uses: 0 },
    update: {
      sql: `UPDATE links SET uses = 1, updated_at = '${T2}' WHERE id = 'lnk_1'`,
      col: 'uses',
      before: 0,
      after: 1,
    },
    untracked: {
      sql: `UPDATE links SET session_id = NULL, updated_at = '${T3}' WHERE id = 'lnk_1'`,
    },
  },
  {
    table: 'access_events',
    id: 'aev_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1' },
    insert: (db) =>
      ins(db, 'access_events', {
        id: 'aev_1',
        entitlement_id: 'ent_1',
        link_id: null,
        kind: 'access_ready',
        at: T,
        source: 'system',
        evidence: j({ note: 'CANARY-EVIDENCE' }),
        environment: 'dryrun',
      }),
    insertCols: { kind: 'access_ready', source: 'system' },
    insertHashed: ['evidence'],
  },
  {
    table: 'recovery_cases',
    id: 'cas_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1', buyer_id: 'buy_1' },
    insert: (db) =>
      ins(db, 'recovery_cases', {
        id: 'cas_1',
        kind: 'delivery_failed',
        state: 'open',
        order_id: 'ord_1',
        entitlement_id: 'ent_1',
        buyer_id: 'buy_1',
        opened_by: 'buyer',
        sla_due_at: T15,
        credit_ms: 0,
        buyer_message: 'CANARY-CASE-MESSAGE',
      }),
    insertCols: {
      kind: 'delivery_failed',
      state: 'open',
      order_id: 'ord_1',
      opened_by: 'buyer',
      credit_ms: 0,
    },
    insertHashed: ['buyer_message'],
    update: {
      sql: `UPDATE recovery_cases SET state = 'diagnosing', updated_at = '${T2}' WHERE id = 'cas_1'`,
      col: 'state',
      before: 'open',
      after: 'diagnosing',
    },
    untracked: {
      sql: `UPDATE recovery_cases SET entitlement_id = NULL, updated_at = '${T3}' WHERE id = 'cas_1'`,
    },
  },
  {
    table: 'recovery_actions',
    id: 'cac_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1' },
    insert: (db) =>
      ins(db, 'recovery_actions', {
        id: 'cac_1',
        case_id: 'cas_1',
        action: 'open',
        actor: 'buyer',
        detail: j({ note: 'CANARY-ACTION-DETAIL' }),
        at: T,
      }),
    insertCols: { action: 'open', actor: 'buyer' },
    insertHashed: ['detail'],
  },
  {
    table: 'alerts',
    id: 'alr_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1', unit_id: 'unt_1' },
    insert: (db) =>
      ins(db, 'alerts', {
        id: 'alr_1',
        kind: 'unit_mismatch',
        order_id: 'ord_1',
        unit_id: 'unt_1',
        detail: j({ reason: 'r', note: 'CANARY-ALERT-DETAIL' }),
      }),
    insertCols: { kind: 'unit_mismatch', order_id: 'ord_1', unit_id: 'unt_1' },
    insertHashed: ['detail'],
    update: {
      sql: `UPDATE alerts SET detail = '{"reason":"r","note":"CANARY-ALERT-DETAIL","n":2}'::jsonb, updated_at = '${T2}' WHERE id = 'alr_1'`,
      col: 'detail',
      before: null,
      after: null,
    },
  },
  {
    // INT-AL (migration 0025): the state history of an alert; append-only, so no update step.
    table: 'alert_events',
    id: 'ale_1',
    chain: 'ord:ord_1',
    subject: { order_id: 'ord_1', unit_id: null },
    insert: (db) =>
      ins(db, 'alert_events', {
        id: 'ale_1',
        alert_id: 'alr_1',
        kind: 'resolved',
        reason_code: 'fixed_upstream',
        note_sha256: HASH,
        at: T,
      }),
    insertCols: {
      alert_id: 'alr_1',
      kind: 'resolved',
      reason_code: 'fixed_upstream',
      note_sha256: HASH,
    },
  },
  {
    table: 'audit_log',
    id: 'aud_1',
    chain: 'plat',
    insert: (db) =>
      ins(db, 'audit_log', {
        id: 'aud_1',
        actor_kind: 'operator',
        actor_id: 'opr_test',
        action: 'order.view',
        target: 'ord_1',
        reason: 'CANARY-AUDIT-REASON',
        detail: j({ note: 'CANARY-AUDIT-DETAIL' }),
      }),
    insertCols: {
      actor_kind: 'operator',
      actor_id: 'opr_test',
      action: 'order.view',
      target: 'ord_1',
    },
    insertHashed: ['reason', 'detail'],
  },
  {
    table: 'api_keys',
    id: 'key_1',
    chain: 'key:key_1',
    subject: { buyer_id: 'buy_1' },
    insert: (db) =>
      ins(
        db,
        'api_keys',
        {
          id: 'key_1',
          owner_kind: 'buyer',
          owner_id: 'buy_1',
          key_kind: 'agent',
          agent_buyer_id: 'buy_1',
          scopes: ['agent:buy'],
          secret_hash: HASH,
          created_at: T,
          revoked_at: null,
          last_used_at: null,
        },
        false,
      ),
    insertCols: { key_kind: 'agent', scopes: ['agent:buy'], revoked_at: null },
    update: {
      sql: `UPDATE api_keys SET revoked_at = '${T2}' WHERE id = 'key_1'`,
      col: 'revoked_at',
      before: null,
      after: '2026-11-04T11:00:00+00:00',
    },
    untracked: { sql: `UPDATE api_keys SET last_used_at = '${T3}' WHERE id = 'key_1'` },
  },
  {
    table: 'mandates',
    id: 'man_1',
    chain: 'mdt:man_1',
    subject: { mandate_ref: 'man_1', buyer_id: 'buy_1' },
    insert: (db) =>
      ins(db, 'mandates', {
        id: 'man_1',
        buyer_id: 'buy_1',
        agent_key_id: 'key_1',
        currency: 'USD',
        max_total_minor: 1000,
        max_count: 5,
        max_per_purchase_minor: 500,
        expires_at: '2026-12-04T10:00:00Z',
        revoked_at: null,
        spent_minor: 0,
        used_count: 0,
        exhausted_at: null,
      }),
    insertCols: {
      max_total_minor: 1000,
      max_count: 5,
      max_per_purchase_minor: 500,
      spent_minor: 0,
      used_count: 0,
    },
    update: {
      sql: `UPDATE mandates SET spent_minor = 500, used_count = 1, updated_at = '${T2}' WHERE id = 'man_1'`,
      col: 'spent_minor',
      before: 0,
      after: 500,
    },
    untracked: {
      sql: `UPDATE mandates SET currency = 'USD', updated_at = '${T3}' WHERE id = 'man_1'`,
    },
  },
  {
    table: 'mandate_reservations',
    id: 'rsv_1',
    chain: 'mdt:man_1',
    subject: { mandate_ref: 'man_1' },
    insert: (db) =>
      ins(
        db,
        'mandate_reservations',
        {
          id: 'rsv_1',
          mandate_id: 'man_1',
          order_id: null,
          amount_minor: 500,
          state: 'held',
          created_at: T,
          settled_at: null,
        },
        false,
      ),
    insertCols: { amount_minor: 500, state: 'held', order_id: null, settled_at: null },
    // attachOrder: the reservation's next event moves to the order chain (its earlier events stay on mdt:).
    update: {
      sql: `UPDATE mandate_reservations SET order_id = 'ord_1' WHERE id = 'rsv_1'`,
      col: 'order_id',
      before: null,
      after: 'ord_1',
    },
  },
  {
    table: 'safety_switches',
    id: 'paypal_outbound',
    chain: 'plat',
    update: {
      sql: `UPDATE safety_switches SET "on" = true, changed_by = 'opr_test', changed_at = '${T2}', reason = 'CANARY-SWITCH-REASON', updated_at = '${T2}' WHERE name = 'paypal_outbound'`,
      col: 'on',
      before: false,
      after: true,
    },
  },
  {
    table: 'outbound_approvals',
    id: 'oap_1',
    chain: 'plat',
    insert: (db) =>
      ins(db, 'outbound_approvals', {
        id: 'oap_1',
        approval_ref: 'D-TEST',
        scope: 'mvp_c_refunds',
        operations: ['oauth_token', 'create_order'],
        max_amount_minor: 500,
        max_calls_per_day: 40,
        valid_until: '2026-11-04T14:00:00Z',
        approved_by: 'vikram',
      }),
    insertCols: {
      scope: 'mvp_c_refunds',
      operations: ['oauth_token', 'create_order'],
      max_amount_minor: 500,
      max_calls_per_day: 40,
    },
    insertHashed: ['approved_by'],
  },
  {
    table: 'payee_decisions',
    id: 'pdc_1',
    chain: 'pub:pub_1',
    subject: { publisher_id: 'pub_1' },
    insert: async (db) => {
      await ins(db, 'payee_change_requests', {
        id: 'pcr_1',
        publisher_id: 'pub_1',
        requested_merchant_id: 'MERCH2',
        note: 'CANARY-PAYEE-NOTE',
        created_by: 'pub_1',
      });
      await ins(db, 'payee_decisions', {
        id: 'pdc_1',
        request_id: 'pcr_1',
        decision: 'verified',
        operator_id: 'opr_test',
        reason: 'CANARY-PAYEE-REASON',
      });
    },
    insertCols: { decision: 'verified', operator_id: 'opr_test' },
    insertHashed: ['reason'],
  },
  {
    table: 'publisher_applicant_decisions',
    id: 'pad_1',
    chain: 'pub:pub_2',
    subject: { publisher_id: 'pub_2' },
    insert: (db) =>
      ins(db, 'publisher_applicant_decisions', {
        id: 'pad_1',
        publisher_id: 'pub_2',
        decision: 'approved',
        operator_id: 'opr_test',
        reason: 'CANARY-APPLICANT-REASON',
      }),
    insertCols: { decision: 'approved', operator_id: 'opr_test' },
    insertHashed: ['reason'],
  },
  {
    table: 'rule_settings',
    id: 'rls_1',
    chain: 'plat',
    insert: (db) =>
      ins(
        db,
        'rule_settings',
        {
          id: 'rls_1',
          rule_key: 'refund.request_window',
          scope_kind: 'platform',
          scope_id: null,
          value: 14,
          effective_from: '2026-11-05T00:00:00Z',
          effective_until: null,
          set_by: 'opr_test',
          reason: 'CANARY-RULE-REASON',
          approved_by: null,
          created_at: T,
        },
        false,
      ),
    insertCols: {
      rule_key: 'refund.request_window',
      scope_kind: 'platform',
      scope_id: null,
      value: 14,
      set_by: 'opr_test',
    },
    insertHashed: ['reason'],
  },
];

/** Every canary string the world writes into a free-text or jsonb detail column. */
export const CANARIES = [
  'CANARY-SNAPSHOT',
  'CANARY-CALL-REQUEST',
  'CANARY-CALL-RESPONSE',
  'CANARY-REFUND-REASON',
  'CANARY-RECEIPT-BODY',
  'CANARY-EVIDENCE',
  'CANARY-CASE-MESSAGE',
  'CANARY-ACTION-DETAIL',
  'CANARY-ALERT-DETAIL',
  'CANARY-AUDIT-REASON',
  'CANARY-AUDIT-DETAIL',
  'CANARY-SWITCH-REASON',
  'CANARY-PAYEE-REASON',
  'CANARY-PAYEE-NOTE',
  'CANARY-APPLICANT-REASON',
  'CANARY-RULE-REASON',
] as const;

/** Runs every insert of the world in order, under one context. Returns the database the app would see. */
export async function seedWorld(
  db: Db,
  c: TraceContext = ctx({ channel: 'seed', actor_kind: 'system', actor_id: null, mfa: false }),
): Promise<void> {
  const traced = as(db, c);
  for (const s of STEPS) if (s.insert) await s.insert(traced);
}

/** Runs every update of the world in order, under one context. */
export async function updateWorld(db: Db, c: TraceContext = ctx()): Promise<void> {
  const traced = as(db, c);
  for (const s of STEPS) if (s.update) await traced.query(s.update.sql, s.update.params);
}

/**
 * Test target only: switches the named user triggers off for the callback and back on after it, so a
 * tamper reaches the data the way an attacker with table rights and no trigger rights would not. The
 * callback gets the plain database.
 */
export async function withTriggersOff<T>(
  db: Database,
  triggers: { table: string; trigger: string }[],
  fn: () => Promise<T>,
): Promise<T> {
  for (const t of triggers) await db.exec(`ALTER TABLE ${t.table} DISABLE TRIGGER ${t.trigger}`);
  try {
    return await fn();
  } finally {
    for (const t of triggers) await db.exec(`ALTER TABLE ${t.table} ENABLE TRIGGER ${t.trigger}`);
  }
}

/** The capture trigger of a tracked table. */
export const captureOf = (table: string) => ({ table, trigger: `trace_capture_${table}` });
/** The append-only guard on the journal itself. */
export const EVENTS_GUARD = { table: 'trace_events', trigger: 'trace_events_append_only' };
