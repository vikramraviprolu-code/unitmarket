// INT-SR0 test support (not a test file, not exported by the package). Writes small, valid worlds into a
// migrated database with plain SQL, so the view, scope and filter tests read real rows. Every id and every
// time is given by the caller: no clock, no randomness. Test data only.
import type { Database, SqlExecutor } from '@umsbx/contracts';
import { migrate, openDatabase } from '@umsbx/db';

export const T0 = '2026-11-01T12:00:00.000Z';
/** The time the fixtures treat as "now" when a test asks the filters for an age. */
export const NOW = new Date('2026-11-05T12:00:00.000Z');

export type Db = Database & { close(): Promise<void> };

export async function openMigrated(): Promise<Db> {
  const db = await openDatabase({ kind: 'pglite-memory' });
  await migrate(db, { now: () => new Date(T0) });
  return db;
}

const hex = (n: number): string => n.toString(16).padStart(64, '0');
let seq = 0;
const next = (): number => {
  seq += 1;
  return seq;
};

export async function seedBuyer(db: SqlExecutor, id: string, display_name: string): Promise<void> {
  await db.query(
    `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
     VALUES ($1, $2, $3, 'US', $4, $4)`,
    [id, display_name, `sub-${id}`, T0],
  );
}

export async function seedPublisher(
  db: SqlExecutor,
  id: string,
  slug: string,
  display_name: string,
): Promise<void> {
  await db.query(
    `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'US', $4, $5, $5)`,
    [id, slug, display_name, `MERCH${id.toUpperCase().replace(/[^A-Z0-9]/g, '')}`, T0],
  );
}

export async function seedArticle(
  db: SqlExecutor,
  id: string,
  publisher_id: string,
  title: string,
): Promise<void> {
  const n = next();
  await db.query(
    `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
     VALUES ($1, $2, $3, 'abstract', 'en', ARRAY['news'], $4, $5, $6, 10, 'text/plain', $4, $4)`,
    [id, publisher_id, title, T0, hex(n), `content-${id}`],
  );
}

export async function seedCorridor(db: SqlExecutor, id: string, currency: string): Promise<void> {
  await db.query(
    `INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
     VALUES ($1, $2, 2, ARRAY['US'], ARRAY['US'], true, 0, true, $3, $3)`,
    [id, currency, T0],
  );
}

export interface UnitSpec {
  id: string;
  publisher: string;
  amount_minor: number;
  status: string;
  refunded_minor?: number;
  /** Defaults to created_at of the order. */
  updated_at?: string;
  captured_verified_at?: string;
  capture_id?: string;
  /** Article ids; each becomes one entitlement of this unit. */
  articles?: string[];
  /** Which provider order of the order this unit belongs to; default the first one, or the publisher's. */
  po?: string;
}

export interface ProviderOrderSpec {
  id: string;
  provider_order_id: string | null;
  publisher?: string;
}

export interface OrderSpec {
  id: string;
  buyer: string;
  created_at: string;
  status: string;
  currency?: string;
  corridor?: string;
  environment?: 'dryrun' | 'sandbox';
  mismatch?: boolean;
  /** Default: one single-route provider order with a generated PayPal id. */
  provider_orders?: ProviderOrderSpec[];
  units: UnitSpec[];
}

const CAPTURED = new Set([
  'captured_verified',
  'partially_refunded',
  'refunded',
  'reversal_suspected',
  'reversed',
]);

const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/** An approval, an order, its provider orders, its units and their entitlements. */
export async function seedOrder(db: SqlExecutor, o: OrderSpec): Promise<void> {
  const env = o.environment ?? 'dryrun';
  const n = next();
  const approval = `apr_${o.id}`;
  await db.query(
    `INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, used_at, environment, created_at, updated_at)
     VALUES ($1, $2, '{}'::jsonb, $3, $4, $5, NULL, $6, $7, $7)`,
    [
      approval,
      o.buyer,
      hex(n),
      `nonce-${o.id}`,
      plus(o.created_at, 15 * 60_000),
      env,
      o.created_at,
    ],
  );
  const total = o.units.reduce((s, u) => s + u.amount_minor, 0);
  const orderRef = `ref_${o.id}`;
  await db.query(
    `INSERT INTO orders (id, approval_id, buyer_id, content_hash, order_ref, expected, status, mismatch, corridor_id, currency, total_minor, environment, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7, $8, $9, $10, $11, $12, $12)`,
    [
      o.id,
      approval,
      o.buyer,
      hex(1000 + n),
      orderRef,
      o.status,
      o.mismatch ?? false,
      o.corridor ?? 'us-usd',
      o.currency ?? 'USD',
      total,
      env,
      o.created_at,
    ],
  );
  const pos = o.provider_orders ?? [
    { id: `po_${o.id}`, provider_order_id: `PAYPAL${String(n).padStart(6, '0')}` },
  ];
  for (const [i, po] of pos.entries()) {
    const route = po.publisher === undefined ? 'single' : 'per_publisher';
    await db.query(
      `INSERT INTO provider_orders (id, order_id, provider_order_id, route, approve_url, status, created_at, updated_at, position, po_ref, publisher_id, state, first_approved_at)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5, $5, $6, $7, $8, 'prepared', NULL)`,
      [
        po.id,
        o.id,
        po.provider_order_id,
        route,
        o.created_at,
        i + 1,
        i === 0 && route === 'single' ? orderRef : `${orderRef}-p${i + 1}`,
        po.publisher ?? null,
      ],
    );
  }
  for (const u of o.units) {
    const poId = u.po ?? pos.find((p) => p.publisher === u.publisher)?.id ?? pos[0]!.id;
    const captured = CAPTURED.has(u.status);
    await db.query(
      `INSERT INTO order_units (id, order_id, provider_order_ref, publisher_id, reference_id, payee_merchant_id, amount_minor, platform_fee_minor, capture_id, status, status_reason, paypal_fee_minor, refunded_minor, captured_verified_at, mismatch_reason, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, NULL, NULL, $10, $11, NULL, $12, $13)`,
      [
        u.id,
        o.id,
        poId,
        u.publisher,
        `reference-${u.id}`,
        `MERCH${u.publisher.toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
        u.amount_minor,
        u.capture_id ?? (captured ? `CAP_${u.id}` : null),
        u.status,
        u.refunded_minor ?? 0,
        u.captured_verified_at ?? (captured ? o.created_at : null),
        o.created_at,
        u.updated_at ?? o.created_at,
      ],
    );
    for (const a of u.articles ?? []) {
      await db.query(
        `INSERT INTO entitlements (id, buyer_id, article_id, unit_id, option, policy, money_state, access_state, licence_state, transition_log, environment, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'keep_retrieve', '{}'::jsonb, 'denied', 'locked', NULL, '[]'::jsonb, $5, $6, $6)`,
        [`ent_${u.id}_${a}`, o.buyer, a, u.id, env, o.created_at],
      );
    }
  }
}

export async function seedRefund(
  db: SqlExecutor,
  r: {
    id: string;
    unit: string;
    state: string;
    created_at: string;
    refund_id?: string;
    amount_minor?: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO refund_requests (id, unit_id, capture_id, amount_minor, currency, reason, requested_by, state, refund_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'USD', 'reason', 'buyer', $5, $6, $7, $7)`,
    [
      r.id,
      r.unit,
      `CAP_${r.unit}`,
      r.amount_minor ?? null,
      r.state,
      r.refund_id ?? null,
      r.created_at,
    ],
  );
}

export async function seedCase(
  db: SqlExecutor,
  c: { id: string; order: string; buyer: string; kind: string; state: string; created_at: string },
): Promise<void> {
  await db.query(
    `INSERT INTO recovery_cases (id, kind, state, order_id, entitlement_id, buyer_id, opened_by, sla_due_at, credit_ms, buyer_message, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, 'system', $6, 0, 'message', $6, $6)`,
    [c.id, c.kind, c.state, c.order, c.buyer, c.created_at],
  );
}

export async function seedAlert(
  db: SqlExecutor,
  a: { id: string; order: string; unit?: string; kind: string; reason: string },
): Promise<void> {
  await db.query(
    `INSERT INTO alerts (id, kind, order_id, unit_id, detail, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)`,
    [a.id, a.kind, a.order, a.unit ?? null, JSON.stringify({ reason: a.reason }), T0],
  );
}

export async function seedUnknownOperation(
  db: SqlExecutor,
  op: { id: string; order: string; unit?: string },
): Promise<void> {
  await db.query(
    `INSERT INTO operations (id, order_id, unit_id, kind, state, attempt, request_id, first_sent_at, idem_safe_until, lease_until, next_retry_at, reconcile_until, failure_reason, created_at, updated_at, provider_order_ref)
     VALUES ($1, $2, $3, 'capture', 'unknown', 1, $4, $5, NULL, NULL, NULL, $6, NULL, $5, $5, NULL)`,
    [op.id, op.order, op.unit ?? null, `req-${op.id}`, T0, plus(T0, 3_600_000)],
  );
}

export async function seedReceipt(db: SqlExecutor, id: string, order: string): Promise<void> {
  await db.query(
    `INSERT INTO receipts (id, order_id, version, body, sha256, environment, created_at, updated_at)
     VALUES ($1, $2, 1, '{}'::jsonb, $3, 'dryrun', $4, $4)`,
    [id, order, hex(next() + 5000), T0],
  );
}

/** An agent key of `buyer`, a mandate for it, and a reservation that ties `order` to the mandate. */
export async function seedAgentBuy(
  db: SqlExecutor,
  a: { key: string; mandate: string; buyer: string; order: string },
): Promise<void> {
  await db.query(
    `INSERT INTO api_keys (id, owner_kind, owner_id, key_kind, agent_buyer_id, scopes, secret_hash, created_at)
     VALUES ($1, 'buyer', $2, 'agent', $2, ARRAY['agent:buy'], $3, $4)`,
    [a.key, a.buyer, hex(next() + 9000), T0],
  );
  await db.query(
    `INSERT INTO mandates (id, buyer_id, agent_key_id, currency, max_total_minor, max_count, max_per_purchase_minor, expires_at, revoked_at, spent_minor, used_count, exhausted_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'USD', 5000, NULL, NULL, $4, NULL, 0, 0, NULL, $5, $5)`,
    [a.mandate, a.buyer, a.key, plus(T0, 30 * 86_400_000), T0],
  );
  await db.query(
    `INSERT INTO mandate_reservations (id, mandate_id, order_id, amount_minor, state, created_at, settled_at)
     VALUES ($1, $2, $3, 100, 'committed', $4, $4)`,
    [`rsv_${a.order}`, a.mandate, a.order, T0],
  );
}

/**
 * The standard world of the scope and filter tests: two buyers, two sellers, a mix of statuses.
 *   b1 "Ada Buyer", b2 "Bo Buyer"; p1 "Harbour Markets" (harbour), p2 "Pine Press" (pine)
 *   o1 b1 paid        p1  500 USD  "Harbour Daily"
 *   o2 b1 paid        p2 1200 USD  "Pine Weekly" + "Pine Extra"
 *   o3 b2 paid        p1  300 USD  "Harbour Daily"  (an agent buy)
 *   o4 b2 unresolved  p2  800 USD  "Pine Weekly"
 */
export async function seedStandardWorld(db: SqlExecutor): Promise<void> {
  await seedBuyer(db, 'b1', 'Ada Buyer');
  await seedBuyer(db, 'b2', 'Bo Buyer');
  await seedPublisher(db, 'p1', 'harbour', 'Harbour Markets');
  await seedPublisher(db, 'p2', 'pine', 'Pine Press');
  await seedArticle(db, 'a1', 'p1', 'Harbour Daily');
  await seedArticle(db, 'a2', 'p2', 'Pine Weekly');
  await seedArticle(db, 'a3', 'p2', 'Pine Extra');
  await seedOrder(db, {
    id: 'o1',
    buyer: 'b1',
    created_at: '2026-11-01T10:00:00.000Z',
    status: 'paid',
    units: [
      {
        id: 'u1',
        publisher: 'p1',
        amount_minor: 500,
        status: 'captured_verified',
        articles: ['a1'],
      },
    ],
  });
  await seedOrder(db, {
    id: 'o2',
    buyer: 'b1',
    created_at: '2026-11-02T10:00:00.000Z',
    status: 'paid',
    units: [
      {
        id: 'u2',
        publisher: 'p2',
        amount_minor: 1200,
        status: 'captured_verified',
        articles: ['a2', 'a3'],
      },
    ],
  });
  await seedOrder(db, {
    id: 'o3',
    buyer: 'b2',
    created_at: '2026-11-03T10:00:00.000Z',
    status: 'paid',
    units: [
      {
        id: 'u3',
        publisher: 'p1',
        amount_minor: 300,
        status: 'captured_verified',
        articles: ['a1'],
      },
    ],
  });
  await seedAgentBuy(db, { key: 'key_b2', mandate: 'man_b2', buyer: 'b2', order: 'o3' });
  await seedOrder(db, {
    id: 'o4',
    buyer: 'b2',
    created_at: '2026-11-04T10:00:00.000Z',
    status: 'unresolved',
    units: [{ id: 'u4', publisher: 'p2', amount_minor: 800, status: 'pending', articles: ['a2'] }],
  });
}
