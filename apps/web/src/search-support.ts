// Test support for the INT-SR1 suites (not a test, not imported by product code). One booted offline app
// with the API-A rig, the views-seed world of domain/txn-search (buyers vs_b1 and vs_b2, seller vs_p1) added
// to its database, and a helper that writes many plain sales for an existing buyer and seller. The `now` of
// the seed is the app's own injected clock, so "Refunds today" and "pending for an hour" line up.
import type { Actor, SqlExecutor } from '@umsbx/contracts';
import { seedViewsWorld } from '@umsbx/txn-search';
import type { AppOptions } from '../composition.server';
import { bootA, json } from './api-v1/a-support';
import type { ARig, Handler, Sess } from './api-v1/a-support';

export { json };
export type { ARig, Handler, Sess };

export interface SearchRig extends ARig {
  now: Date;
  vsBuyer1: Actor;
  vsBuyer2: Actor;
  vsSeller: Actor;
}

export async function bootSearch(
  over: Record<string, string> = {},
  opts: AppOptions = {},
): Promise<SearchRig> {
  const rig = await bootA(over, opts);
  const now = rig.app.security.clock.now();
  await seedViewsWorld(rig.app.db, now);
  return {
    ...rig,
    now,
    vsBuyer1: { kind: 'buyer', buyer_id: 'vs_b1' },
    vsBuyer2: { kind: 'buyer', buyer_id: 'vs_b2' },
    vsSeller: { kind: 'publisher', publisher_id: 'vs_p1' },
  };
}

const hex = (n: number): string => n.toString(16).padStart(64, '0');
let counter = 0;

export interface SalesSeed {
  buyer_id: string;
  publisher_id: string;
  count: number;
  /** Order i is created at `from` + i minutes. */
  from: Date;
  status?: string;
  order_status?: string;
  amount_minor?: number;
  currency?: string;
  environment?: 'dryrun' | 'sandbox';
  /** Order refs are `${prefix}${i}`. */
  prefix: string;
}

/** `count` single-unit orders for one buyer and one seller. Returns the order refs, oldest first. */
export async function seedSales(db: SqlExecutor, s: SalesSeed): Promise<string[]> {
  const corridor = (
    await db.query<{ id: string }>(
      `SELECT id FROM corridors WHERE currency = 'USD' AND enabled LIMIT 1`,
    )
  ).rows[0]!.id;
  const merchant = (
    await db.query<{ m: string }>('SELECT paypal_merchant_id AS m FROM publishers WHERE id = $1', [
      s.publisher_id,
    ])
  ).rows[0]!.m;
  const env = s.environment ?? 'dryrun';
  const unitStatus = s.status ?? 'captured_verified';
  const refs: string[] = [];
  for (let i = 0; i < s.count; i++) {
    counter += 1;
    const created = new Date(s.from.getTime() + i * 60_000).toISOString();
    const o = `${s.prefix}o${String(i)}`;
    const ref = `${s.prefix}${String(i).padStart(3, '0')}`;
    refs.push(ref);
    await db.query(
      `INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, used_at, environment, created_at, updated_at)
       VALUES ($1, $2, '{}'::jsonb, $3, $4, $5, NULL, $6, $7, $7)`,
      [
        `apr_${o}`,
        s.buyer_id,
        hex(100_000 + counter),
        `nonce-${o}`,
        new Date(Date.parse(created) + 900_000).toISOString(),
        env,
        created,
      ],
    );
    await db.query(
      `INSERT INTO orders (id, approval_id, buyer_id, content_hash, order_ref, expected, status, mismatch, corridor_id, currency, total_minor, environment, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, false, $7, $8, $9, $10, $11, $11)`,
      [
        o,
        `apr_${o}`,
        s.buyer_id,
        hex(200_000 + counter),
        ref,
        s.order_status ?? 'paid_partial',
        corridor,
        s.currency ?? 'USD',
        s.amount_minor ?? 500,
        env,
        created,
      ],
    );
    await db.query(
      `INSERT INTO provider_orders (id, order_id, provider_order_id, route, approve_url, status, created_at, updated_at, position, po_ref, publisher_id, state, first_approved_at)
       VALUES ($1, $2, $3, 'single', NULL, NULL, $4, $4, 1, $5, NULL, 'prepared', NULL)`,
      [`po_${o}`, o, `PPS${String(counter).padStart(8, '0')}`, created, ref],
    );
    await db.query(
      `INSERT INTO order_units (id, order_id, provider_order_ref, publisher_id, reference_id, payee_merchant_id, amount_minor, platform_fee_minor, capture_id, status, status_reason, paypal_fee_minor, refunded_minor, captured_verified_at, mismatch_reason, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, NULL, NULL, 0, $10, NULL, $11, $11)`,
      [
        `${s.prefix}u${String(i)}`,
        o,
        `po_${o}`,
        s.publisher_id,
        `reference-${o}`,
        merchant,
        s.amount_minor ?? 500,
        unitStatus === 'captured_verified' ? `CAPS${String(counter)}` : null,
        unitStatus,
        unitStatus === 'captured_verified' ? created : null,
        created,
      ],
    );
  }
  return refs;
}

/** `count` single-unit orders in one statement, in the journal's bulk-load mode (see the SR0 plan test). */
export async function seedBulkSales(
  db: { exec(sql: string): Promise<unknown> },
  q: {
    buyer_id: string;
    publisher_id: string;
    merchant: string;
    corridor: string;
    count: number;
    prefix: string;
    from: Date;
  },
): Promise<void> {
  const p = q.prefix.replace(/[^a-z0-9_]/gi, '');
  const at = `timestamptz '${q.from.toISOString()}' + (g * interval '1 second')`;
  await db.exec(`
SELECT set_config('ums.trace', '{"mode":"restore"}', true);
CREATE TEMP TABLE bulk_src AS SELECT g AS i, ${at} AS at FROM generate_series(1, ${String(q.count)}) AS g;
INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, used_at, environment, created_at, updated_at)
SELECT 'apr_${p}' || i, '${q.buyer_id}', '{}'::jsonb, lpad(to_hex(i + 5000000), 64, '0'), 'nonce-${p}' || i, at + interval '15 minutes', NULL, 'dryrun', at, at FROM bulk_src;
INSERT INTO orders (id, approval_id, buyer_id, content_hash, order_ref, expected, status, mismatch, corridor_id, currency, total_minor, environment, created_at, updated_at)
SELECT '${p}o' || i, 'apr_${p}' || i, '${q.buyer_id}', lpad(to_hex(i + 6000000), 64, '0'), '${p}' || lpad(i::text, 6, '0'), '{}'::jsonb, 'paid_partial', false, '${q.corridor}', 'USD', 500, 'dryrun', at, at FROM bulk_src;
INSERT INTO provider_orders (id, order_id, provider_order_id, route, approve_url, status, created_at, updated_at, position, po_ref, publisher_id, state, first_approved_at)
SELECT 'po_${p}' || i, '${p}o' || i, 'PPB' || '${p}' || lpad(i::text, 8, '0'), 'single', NULL, NULL, at, at, 1, '${p}' || lpad(i::text, 6, '0'), NULL, 'prepared', NULL FROM bulk_src;
INSERT INTO order_units (id, order_id, provider_order_ref, publisher_id, reference_id, payee_merchant_id, amount_minor, platform_fee_minor, capture_id, status, status_reason, paypal_fee_minor, refunded_minor, captured_verified_at, mismatch_reason, created_at, updated_at)
SELECT '${p}u' || i, '${p}o' || i, 'po_${p}' || i, '${q.publisher_id}', 'reference-${p}' || i, '${q.merchant}', 500, 0, 'CAPB${p}' || i, 'captured_verified', NULL, NULL, 0, at, NULL, at, at FROM bulk_src;
DROP TABLE bulk_src;
`);
}
