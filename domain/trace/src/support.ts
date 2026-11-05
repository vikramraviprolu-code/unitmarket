// Test support for the INT-TR1 suites (not a test, never imported by product code). One migrated in-memory
// database and one world: a two-seller order (seller A unit 500, seller B unit 200) that was paid, unlocked,
// downloaded and partly refunded, written under the contexts a real run would have (buyer on the web, PayPal
// webhook, system job, an agent key, an operator with and without the second factor). Canary strings sit in
// every field a persona or the evidence pack must never show.
import type { Clock, Database, SqlExecutor, TraceContext } from '@umsbx/contracts';
import { migrate, openDatabase, withTraceDb } from '@umsbx/db';
import type { SqlDriver } from '@umsbx/db';

export type Db = SqlDriver;
export const HASH = 'a'.repeat(64);
export const HASH2 = 'b'.repeat(64);
export const day = (hh: number, mm = 0, ss = 0, d = 4): string =>
  `2026-11-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`;
export const T0 = day(9);

export const CANARY = {
  buyerName: 'CANARY-BUYER-NAME',
  buyerSub: 'canary-auth-subject',
  ip: 'CANARY-RAW-IP',
  ua: 'CANARY-USER-AGENT',
  reason: 'CANARY-REFUND-REASON',
  message: 'CANARY-CASE-MESSAGE',
  secret: 'CANARY-AGENT-SECRET',
} as const;

export async function freshDb(): Promise<Db> {
  const d = await openDatabase({ kind: 'pglite-memory' });
  await migrate(d, { now: () => new Date(T0) });
  return d;
}

let n = 0;
export function ctx(over: Partial<TraceContext> = {}): TraceContext {
  n += 1;
  return {
    id: `ctx_t1_${String(n).padStart(6, '0')}`,
    at: T0,
    channel: 'web',
    actor_kind: 'buyer',
    actor_id: 'buy_1',
    on_behalf_of: null,
    mandate_id: null,
    mfa: false,
    req_id: `req_t1_${n}`,
    ip_hash: 'c'.repeat(32),
    ua_family: 'browser',
    api_key_id: null,
    job: null,
    tool: null,
    ...over,
  };
}

export const CTX = {
  seed: (): TraceContext =>
    ctx({
      channel: 'seed',
      actor_kind: 'system',
      actor_id: null,
      ip_hash: null,
      ua_family: null,
      req_id: null,
    }),
  buyer: (): TraceContext => ctx(),
  agent: (): TraceContext =>
    ctx({
      channel: 'mcp',
      actor_kind: 'agent',
      actor_id: 'key_wxyz1234',
      on_behalf_of: 'buy_1',
      api_key_id: 'key_wxyz1234',
      mandate_id: 'man_1',
      tool: 'buy',
      ua_family: 'sdk',
    }),
  webhook: (): TraceContext =>
    ctx({ channel: 'webhook', actor_kind: 'paypal', actor_id: null, ua_family: 'other' }),
  job: (job = 'pass'): TraceContext =>
    ctx({
      channel: 'job',
      actor_kind: 'system',
      actor_id: null,
      ip_hash: null,
      ua_family: null,
      req_id: null,
      job,
    }),
  operator: (mfa = true): TraceContext => ctx({ actor_kind: 'operator', actor_id: 'opr_1', mfa }),
};

/** The database as the app sees it while `c` is open: every write is attributed to it, at time `at`. */
export function as<D extends Database>(db: D, c: TraceContext, at: string): D {
  const clock: Clock = { now: () => new Date(at) };
  return withTraceDb(db, () => c, clock);
}

export const j = (v: unknown): string => JSON.stringify(v);

export async function ins(
  db: SqlExecutor,
  table: string,
  row: Record<string, unknown>,
  at: string,
): Promise<void> {
  const r: Record<string, unknown> = { created_at: at, updated_at: at, ...row };
  const cols = Object.keys(r);
  await db.query(
    `INSERT INTO ${table} (${cols.map((c) => (c === 'on' ? '"on"' : c)).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}

export interface World {
  order_id: 'ord_1';
  order_ref: 'ref_1';
  other_order_ref: 'ref_2';
  unit_a: 'unt_a';
  unit_b: 'unt_b';
  pub_a: 'pub_a';
  pub_b: 'pub_b';
  buyer_1: 'buy_1';
  buyer_2: 'buy_2';
  agent_key: 'key_wxyz1234';
}

/** Builds the world. Event times run from 09:00 to 10:30 UTC on 2026-11-04. */
export async function seedWorld(raw: Db): Promise<World> {
  const w = (c: TraceContext, at: string) => as(raw, c, at);
  const seed = w(CTX.seed(), T0);
  for (const [id, slug, merchant] of [
    ['pub_a', 'pa', 'MERCH_A'],
    ['pub_b', 'pb', 'MERCH_B'],
  ] as const) {
    await ins(
      seed,
      'publishers',
      {
        id,
        slug,
        display_name: `Seller ${slug}`,
        country: 'US',
        paypal_merchant_id: merchant,
        payee_verified_at: T0,
      },
      T0,
    );
    await ins(
      seed,
      'articles',
      {
        id: `art_${slug}`,
        publisher_id: id,
        title: `Title ${slug}`,
        abstract: 'a',
        language: 'en',
        topics: ['x'],
        published_at: T0,
        sha256: HASH,
        content_key: `k_${slug}`,
        bytes: 10,
        mime: 'text/plain',
      },
      T0,
    );
  }
  for (const [id, sub, name] of [
    ['buy_1', CANARY.buyerSub, CANARY.buyerName],
    ['buy_2', 'sub2', 'Other Buyer'],
  ] as const) {
    await ins(seed, 'buyers', { id, display_name: name, auth_subject: sub, country: 'US' }, T0);
  }
  // buyer, 09:10: approval, order, two units, two provider orders
  const t1 = day(9, 10);
  const buyer = w(CTX.buyer(), t1);
  await ins(
    buyer,
    'approvals',
    {
      id: 'apr_1',
      buyer_id: 'buy_1',
      snapshot: j({ v: 1 }),
      content_hash: HASH,
      nonce: 'n1',
      expires_at: day(9, 25),
      used_at: null,
      environment: 'dryrun',
    },
    t1,
  );
  await ins(
    buyer,
    'orders',
    {
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
      total_minor: 700,
      environment: 'dryrun',
    },
    t1,
  );
  for (const [id, pub, amt, merchant, cap] of [
    ['unt_a', 'pub_a', 500, 'MERCH_A', 'CAPA'],
    ['unt_b', 'pub_b', 200, 'MERCH_B', 'CAPB'],
  ] as const) {
    await ins(
      buyer,
      'order_units',
      {
        id,
        order_id: 'ord_1',
        provider_order_ref: null,
        publisher_id: pub,
        reference_id: `refid_${id}`,
        payee_merchant_id: merchant,
        amount_minor: amt,
        platform_fee_minor: 0,
        capture_id: cap,
        status: 'expected',
        status_reason: null,
        paypal_fee_minor: null,
        refunded_minor: 0,
        captured_verified_at: null,
        mismatch_reason: null,
      },
      t1,
    );
  }
  let pos = 0;
  for (const [id, pub] of [
    ['pvo_a', 'pub_a'],
    ['pvo_b', 'pub_b'],
  ] as const) {
    pos += 1;
    await ins(
      buyer,
      'provider_orders',
      {
        id,
        order_id: 'ord_1',
        provider_order_id: pub === 'pub_a' ? 'PPORDERAAAA1234' : 'PPORDERBBBB5678',
        route: 'single',
        approve_url: null,
        status: null,
        position: pos,
        po_ref: `ref_1_${id}`,
        publisher_id: pub,
        state: 'prepared',
        first_approved_at: null,
      },
      t1,
    );
  }
  // buyer, 09:11: approves at PayPal
  const t2 = day(9, 11);
  await w(CTX.buyer(), t2).query(
    `UPDATE orders SET status = 'awaiting_buyer', updated_at = $1 WHERE id = 'ord_1'`,
    [t2],
  );
  // PayPal webhook, 09:12: both units captured, order paid
  const t3 = day(9, 12);
  const hook = w(CTX.webhook(), t3);
  await ins(
    hook,
    'webhook_events',
    {
      id: 'whk_1',
      event_id: 'EV1',
      transmission_id: 'TR1',
      type: 'PAYMENT.CAPTURE.COMPLETED',
      verified: true,
      outcome: null,
      resource: j({ capture_id: 'CAPA', provider_order_id: 'PPORDERAAAA1234' }),
      received_at: t3,
      applied_at: null,
      environment: 'dryrun',
    },
    t3,
  );
  await hook.query(
    `UPDATE order_units SET status = 'captured_verified', captured_verified_at = $1, paypal_fee_minor = 30, updated_at = $1 WHERE id IN ('unt_a','unt_b')`,
    [t3],
  );
  await hook.query(`UPDATE orders SET status = 'paid', updated_at = $1 WHERE id = 'ord_1'`, [t3]);
  // system job, 09:13: ledger, receipt, entitlements
  const t4 = day(9, 13);
  const job = w(CTX.job('pass'), t4);
  for (const [id, unit, cap, amt] of [
    ['led_a', 'unt_a', 'CAPA', 500],
    ['led_b', 'unt_b', 'CAPB', 200],
  ] as const) {
    await ins(
      job,
      'ledger_entries',
      {
        id,
        unit_id: unit,
        capture_id: cap,
        kind: 'sale',
        amount_minor: amt,
        currency: 'USD',
        refund_id: null,
        ref_entry_id: null,
        environment: 'dryrun',
      },
      t4,
    );
  }
  await ins(
    job,
    'receipts',
    {
      id: 'rct_1',
      order_id: 'ord_1',
      version: 1,
      body: j({ who: CANARY.buyerName }),
      sha256: HASH,
      environment: 'dryrun',
    },
    t4,
  );
  for (const [id, unit, art] of [
    ['ent_a', 'unt_a', 'art_pa'],
    ['ent_b', 'unt_b', 'art_pb'],
  ] as const) {
    await ins(
      job,
      'entitlements',
      {
        id,
        buyer_id: 'buy_1',
        article_id: art,
        unit_id: unit,
        option: 'keep_retrieve',
        policy: j({ w: 1 }),
        money_state: 'captured',
        access_state: 'locked',
        licence_state: 'granted',
        transition_log: j([]),
        environment: 'dryrun',
      },
      t4,
    );
  }
  const t5 = day(9, 14);
  await w(CTX.job('pass'), t5).query(
    `UPDATE entitlements SET access_state = 'available', updated_at = $1 WHERE id IN ('ent_a','ent_b')`,
    [t5],
  );
  // the buyer's agent downloads both, 09:20
  const t6 = day(9, 20);
  const agent = w(CTX.agent(), t6);
  for (const [id, ent] of [
    ['aev_a', 'ent_a'],
    ['aev_b', 'ent_b'],
  ] as const) {
    await ins(
      agent,
      'access_events',
      {
        id,
        entitlement_id: ent,
        link_id: null,
        kind: 'download_completed',
        at: t6,
        source: 'buyer',
        evidence: j({ note: CANARY.secret }),
        environment: 'dryrun',
      },
      t6,
    );
  }
  // an operator without the second factor asks for a refund of unit A, 10:00; PayPal completes it, 10:01
  const t7 = day(10);
  await ins(
    w(CTX.operator(false), t7),
    'refund_requests',
    {
      id: 'rfr_a',
      unit_id: 'unt_a',
      capture_id: 'CAPA',
      amount_minor: 100,
      currency: 'USD',
      reason: CANARY.reason,
      requested_by: 'opr_1',
      state: 'requested',
      refund_id: null,
    },
    t7,
  );
  const t8 = day(10, 1);
  await w(CTX.webhook(), t8).query(
    `UPDATE refund_requests SET state = 'completed', refund_id = 'RFD_A', updated_at = $1 WHERE id = 'rfr_a'`,
    [t8],
  );
  // a second order of the other buyer, so a read across buyers has something to find
  const t9 = day(10, 30);
  const b2 = w({ ...CTX.buyer(), actor_id: 'buy_2' }, t9);
  await ins(
    b2,
    'approvals',
    {
      id: 'apr_2',
      buyer_id: 'buy_2',
      snapshot: j({ v: 1 }),
      content_hash: HASH2,
      nonce: 'n2',
      expires_at: day(10, 45),
      used_at: null,
      environment: 'dryrun',
    },
    t9,
  );
  await ins(
    b2,
    'orders',
    {
      id: 'ord_2',
      approval_id: 'apr_2',
      buyer_id: 'buy_2',
      content_hash: HASH2,
      order_ref: 'ref_2',
      expected: j({ lines: [] }),
      status: 'created',
      mismatch: false,
      corridor_id: 'us-usd',
      currency: 'USD',
      total_minor: 300,
      environment: 'dryrun',
    },
    t9,
  );
  return {
    order_id: 'ord_1',
    order_ref: 'ref_1',
    other_order_ref: 'ref_2',
    unit_a: 'unt_a',
    unit_b: 'unt_b',
    pub_a: 'pub_a',
    pub_b: 'pub_b',
    buyer_1: 'buy_1',
    buyer_2: 'buy_2',
    agent_key: 'key_wxyz1234',
  };
}

/** Every string in a value, keys included, for a deep scan. */
export function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) allStrings(x, out);
  else if (v !== null && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allStrings(x, out);
    }
  return out;
}

export const scan = (v: unknown): string => allStrings(v).join('\n');
