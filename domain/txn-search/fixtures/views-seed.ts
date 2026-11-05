// INT-SR1 test data (not product code): eleven small orders that put a known number of lines in each saved
// view, so a state test can count them. Plain SQL through a SqlExecutor; every time is derived from the
// `now` the caller passes (no clock, no randomness). Needs attention 4, Refunds today 2, Agent purchases 5,
// Sandbox only 3. Buyers and sellers are new rows (`vs_*`), so the seed can sit beside any other data.
import type { SqlExecutor } from '@umsbx/contracts';
import type { ViewId } from '../src/views';

export const VIEWS_EXPECTED: Readonly<Record<ViewId, number>> = {
  needs_attention: 4,
  refunds_today: 2,
  agent_purchases: 5,
  sandbox_only: 3,
};

/** The unit ids each view must hold. */
export const VIEWS_MEMBERS: Readonly<Record<ViewId, readonly string[]>> = {
  needs_attention: ['vs_u1', 'vs_u2', 'vs_u3', 'vs_u4'],
  refunds_today: ['vs_u5', 'vs_u6'],
  agent_purchases: ['vs_u3', 'vs_u4', 'vs_u5', 'vs_u8', 'vs_u9'],
  sandbox_only: ['vs_u2', 'vs_u6', 'vs_u9'],
};

const DAY = 86_400_000;
const hex = (n: number): string => n.toString(16).padStart(64, '0');

interface Line {
  n: number;
  buyer: 'vs_b1' | 'vs_b2';
  /** Created today (UTC) or yesterday. */
  when: 'today' | 'yesterday';
  order_status: string;
  unit_status: string;
  amount_minor: number;
  refunded_minor?: number;
  /** How long before `now` the unit last changed. Default: at creation. */
  idle_ms?: number;
  environment: 'dryrun' | 'sandbox';
}

const LINES: readonly Line[] = [
  {
    n: 1,
    buyer: 'vs_b1',
    when: 'today',
    order_status: 'unresolved',
    unit_status: 'pending',
    amount_minor: 500,
    idle_ms: 600_000,
    environment: 'dryrun',
  },
  {
    n: 2,
    buyer: 'vs_b1',
    when: 'yesterday',
    order_status: 'paid_partial',
    unit_status: 'mismatch',
    amount_minor: 500,
    environment: 'sandbox',
  },
  {
    n: 3,
    buyer: 'vs_b2',
    when: 'yesterday',
    order_status: 'capture_requested',
    unit_status: 'reversal_suspected',
    amount_minor: 500,
    environment: 'dryrun',
  },
  {
    n: 4,
    buyer: 'vs_b2',
    when: 'yesterday',
    order_status: 'awaiting_buyer',
    unit_status: 'pending',
    amount_minor: 500,
    idle_ms: 7_200_000,
    environment: 'dryrun',
  },
  {
    n: 5,
    buyer: 'vs_b2',
    when: 'today',
    order_status: 'paid_partial',
    unit_status: 'partially_refunded',
    amount_minor: 500,
    refunded_minor: 100,
    environment: 'dryrun',
  },
  {
    n: 6,
    buyer: 'vs_b1',
    when: 'today',
    order_status: 'paid_partial',
    unit_status: 'refunded',
    amount_minor: 500,
    refunded_minor: 500,
    environment: 'sandbox',
  },
  {
    n: 7,
    buyer: 'vs_b1',
    when: 'yesterday',
    order_status: 'paid_partial',
    unit_status: 'refunded',
    amount_minor: 300,
    refunded_minor: 300,
    environment: 'dryrun',
  },
  {
    n: 8,
    buyer: 'vs_b2',
    when: 'yesterday',
    order_status: 'paid_partial',
    unit_status: 'captured_verified',
    amount_minor: 500,
    environment: 'dryrun',
  },
  {
    n: 9,
    buyer: 'vs_b2',
    when: 'yesterday',
    order_status: 'paid_partial',
    unit_status: 'captured_verified',
    amount_minor: 500,
    environment: 'sandbox',
  },
  {
    n: 10,
    buyer: 'vs_b1',
    when: 'yesterday',
    order_status: 'awaiting_buyer',
    unit_status: 'pending',
    amount_minor: 500,
    idle_ms: 600_000,
    environment: 'dryrun',
  },
  {
    n: 11,
    buyer: 'vs_b1',
    when: 'today',
    order_status: 'paid_partial',
    unit_status: 'captured_verified',
    amount_minor: 500,
    environment: 'dryrun',
  },
];

const CAPTURED = new Set([
  'captured_verified',
  'partially_refunded',
  'refunded',
  'reversal_suspected',
]);

export async function seedViewsWorld(db: SqlExecutor, now: Date): Promise<void> {
  const dayStart = Math.floor(now.getTime() / DAY) * DAY;
  const iso = (ms: number): string => new Date(ms).toISOString();
  const base = iso(dayStart - 3 * DAY);
  for (const [id, name] of [
    ['vs_b1', 'Vera Viewer'],
    ['vs_b2', 'Wes Watcher'],
  ] as const) {
    await db.query(
      `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
       VALUES ($1, $2, $3, 'US', $4, $4)`,
      [id, name, `sub-${id}`, base],
    );
  }
  await db.query(
    `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, created_at, updated_at)
     VALUES ('vs_p1', 'vs-quay', 'Quay Views', 'US', 'MERCHVSP1', $1, $1)`,
    [base],
  );
  await db.query(
    `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
     VALUES ('vs_a1', 'vs_p1', 'Views Daily', 'abstract', 'en', ARRAY['news'], $1, $2, 'content-vs_a1', 10, 'text/plain', $1, $1)`,
    [base, hex(9101)],
  );
  const found = await db.query<{ id: string }>(
    `SELECT id FROM corridors WHERE currency = 'USD' AND enabled LIMIT 1`,
  );
  let corridor = found.rows[0]?.id;
  if (corridor === undefined) {
    corridor = 'vs-usd';
    await db.query(
      `INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
       VALUES ('vs-usd', 'USD', 2, ARRAY['US'], ARRAY['US'], true, 0, true, $1, $1)`,
      [base],
    );
  }
  // One agent key and mandate for vs_b2: its orders are the agent purchases.
  await db.query(
    `INSERT INTO api_keys (id, owner_kind, owner_id, key_kind, agent_buyer_id, scopes, secret_hash, created_at)
     VALUES ('vs_key', 'buyer', 'vs_b2', 'agent', 'vs_b2', ARRAY['agent:buy'], $1, $2)`,
    [hex(9102), base],
  );
  await db.query(
    `INSERT INTO mandates (id, buyer_id, agent_key_id, currency, max_total_minor, max_count, max_per_purchase_minor, expires_at, revoked_at, spent_minor, used_count, exhausted_at, created_at, updated_at)
     VALUES ('vs_man', 'vs_b2', 'vs_key', 'USD', 50000, NULL, NULL, $1, NULL, 0, 0, NULL, $2, $2)`,
    [iso(dayStart + 30 * DAY), base],
  );
  for (const l of LINES) {
    const created = iso(dayStart + (l.when === 'today' ? 0 : -DAY) + l.n);
    const updated = l.idle_ms === undefined ? created : iso(now.getTime() - l.idle_ms);
    const o = `vs_o${String(l.n)}`;
    const u = `vs_u${String(l.n)}`;
    const captured = CAPTURED.has(l.unit_status);
    await db.query(
      `INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, used_at, environment, created_at, updated_at)
       VALUES ($1, $2, '{}'::jsonb, $3, $4, $5, NULL, $6, $7, $7)`,
      [
        `apr_${o}`,
        l.buyer,
        hex(9200 + l.n),
        `nonce-${o}`,
        iso(Date.parse(created) + 900_000),
        l.environment,
        created,
      ],
    );
    await db.query(
      `INSERT INTO orders (id, approval_id, buyer_id, content_hash, order_ref, expected, status, mismatch, corridor_id, currency, total_minor, environment, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, false, $7, 'USD', $8, $9, $10, $10)`,
      [
        o,
        `apr_${o}`,
        l.buyer,
        hex(9300 + l.n),
        `ref_${o}`,
        l.order_status,
        corridor,
        l.amount_minor,
        l.environment,
        created,
      ],
    );
    await db.query(
      `INSERT INTO provider_orders (id, order_id, provider_order_id, route, approve_url, status, created_at, updated_at, position, po_ref, publisher_id, state, first_approved_at)
       VALUES ($1, $2, $3, 'single', NULL, NULL, $4, $4, 1, $5, NULL, 'prepared', NULL)`,
      [`po_${o}`, o, `PAYPALVS${String(l.n).padStart(4, '0')}`, created, `ref_${o}`],
    );
    await db.query(
      `INSERT INTO order_units (id, order_id, provider_order_ref, publisher_id, reference_id, payee_merchant_id, amount_minor, platform_fee_minor, capture_id, status, status_reason, paypal_fee_minor, refunded_minor, captured_verified_at, mismatch_reason, created_at, updated_at)
       VALUES ($1, $2, $3, 'vs_p1', $4, 'MERCHVSP1', $5, 0, $6, $7, NULL, NULL, $8, $9, NULL, $10, $11)`,
      [
        u,
        o,
        `po_${o}`,
        `reference-${u}`,
        l.amount_minor,
        captured ? `CAP_${u}` : null,
        l.unit_status,
        l.refunded_minor ?? 0,
        captured ? created : null,
        created,
        updated,
      ],
    );
    await db.query(
      `INSERT INTO entitlements (id, buyer_id, article_id, unit_id, option, policy, money_state, access_state, licence_state, transition_log, environment, created_at, updated_at)
       VALUES ($1, $2, 'vs_a1', $3, 'keep_retrieve', '{}'::jsonb, 'denied', 'locked', NULL, '[]'::jsonb, $4, $5, $5)`,
      [`ent_${u}`, l.buyer, u, l.environment, created],
    );
    if (l.buyer === 'vs_b2') {
      await db.query(
        `INSERT INTO mandate_reservations (id, mandate_id, order_id, amount_minor, state, created_at, settled_at)
         VALUES ($1, 'vs_man', $2, 100, 'committed', $3, $3)`,
        [`rsv_${o}`, o, created],
      );
    }
  }
}
