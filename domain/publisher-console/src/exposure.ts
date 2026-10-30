// The operator's view of what each publisher holds or is owed (PUB-D, page S7). Read only. Counts and
// sums of stored rows per publisher, currency and stored environment; nothing is projected, and a
// publisher with no payments has no money blocks. The payee is the last 4 characters only. No buyer,
// no order reference and no whole merchant id leaves this module. The caller is an operator with the
// second factor; any other actor gets null.
import type { Actor, EnvironmentLabel, SqlExecutor } from '@umsbx/contracts';
import { payeeSettlement } from './settlement';
import type { Settlement } from './settlement';

export type PublisherStatusValue = 'applied' | 'active' | 'suspended';

export interface ExposureBlock {
  currency: string;
  environment: EnvironmentLabel;
  /** Units in captured_verified or partially_refunded. */
  units_captured: number;
  /** Sum of amount minus refunded over those units. */
  captured_not_refunded_minor: number;
  /** Refund requests that can still become a refund at PayPal. */
  refunds_open_count: number;
  refunds_open_minor: number;
  /** Units pending, reversal_suspected or mismatch. */
  held_count: number;
  held_minor: number;
}

export interface PublisherExposure {
  publisher_id: string;
  slug: string;
  display_name: string;
  status: PublisherStatusValue;
  /** The last 4 characters of the stored payee account, or null. */
  payee_last4: string | null;
  payee_verified_at: string | null;
  payee_shared: boolean;
  /** The same settlement sentence as the publisher's own pages, for the account as it is now. */
  settlement: Settlement;
  offers_live: number;
  /** Ordered by currency, then environment. */
  by_currency: ExposureBlock[];
}

const CAPTURED = "('captured_verified', 'partially_refunded')";
const HELD = "('pending', 'reversal_suspected', 'mismatch')";
// The open states of a refund request (domain/payments keeps the same list).
const OPEN_REFUND = "('requested', 'sent', 'unknown', 'pending', 'unresolved')";

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

function blockOf(map: Map<string, ExposureBlock>, p: string, c: string, e: EnvironmentLabel) {
  const key = `${p}\u0000${c}\u0000${e}`;
  let b = map.get(key);
  if (b === undefined) {
    b = {
      currency: c,
      environment: e,
      units_captured: 0,
      captured_not_refunded_minor: 0,
      refunds_open_count: 0,
      refunds_open_minor: 0,
      held_count: 0,
      held_minor: 0,
    };
    map.set(key, b);
  }
  return b;
}

/** What the composition knows and the database does not: the owner's merchant id and the app environment. */
export interface ExposureContext {
  own_merchant_id: string | null;
  environment: EnvironmentLabel;
}

export async function publisherExposure(
  db: SqlExecutor,
  actor: Actor,
  at: string,
  ctx: ExposureContext,
): Promise<PublisherExposure[] | null> {
  if (actor.kind !== 'operator' || !actor.mfa) return null;
  const pubs = await db.query<{
    id: string;
    slug: string;
    display_name: string;
    status: PublisherStatusValue;
    paypal_merchant_id: string | null;
    payee_verified_at: unknown;
    payee_shared: boolean;
  }>(
    `SELECT id, slug, display_name, status, paypal_merchant_id, payee_verified_at, payee_shared
       FROM publishers ORDER BY display_name, id`,
  );
  // Live: the discovery rule (authorised, newest version, not superseded, inside its dates, covered by an
  // enabled corridor) and the publisher is active.
  const live = await db.query<{ publisher_id: string; n: string | number }>(
    `SELECT o.publisher_id, count(*) AS n
       FROM offers o JOIN publishers p ON p.id = o.publisher_id
      WHERE p.status = 'active' AND o.status = 'authorised' AND o.superseded_by IS NULL
        AND o.valid_from <= $1 AND (o.valid_until IS NULL OR o.valid_until > $1)
        AND EXISTS (SELECT 1 FROM publisher_authorisations pa
                     WHERE pa.offer_id = o.id AND pa.offer_version = o.version)
        AND NOT EXISTS (SELECT 1 FROM offers n WHERE n.id = o.id
                         AND (n.created_at, n.version) > (o.created_at, o.version))
        AND EXISTS (SELECT 1 FROM corridors c
                     WHERE c.enabled AND c.currency = o.currency AND p.country = ANY (c.payee_countries))
      GROUP BY o.publisher_id`,
    [at],
  );
  const units = await db.query<{
    publisher_id: string;
    currency: string;
    environment: EnvironmentLabel;
    captured_n: string | number;
    captured_net: string | number;
    held_n: string | number;
    held_sum: string | number;
  }>(
    `SELECT u.publisher_id, o.currency, o.environment,
            count(*) FILTER (WHERE u.status IN ${CAPTURED}) AS captured_n,
            COALESCE(sum(u.amount_minor - u.refunded_minor) FILTER (WHERE u.status IN ${CAPTURED}), 0) AS captured_net,
            count(*) FILTER (WHERE u.status IN ${HELD}) AS held_n,
            COALESCE(sum(u.amount_minor) FILTER (WHERE u.status IN ${HELD}), 0) AS held_sum
       FROM order_units u JOIN orders o ON o.id = u.order_id
      GROUP BY u.publisher_id, o.currency, o.environment`,
  );
  const refunds = await db.query<{
    publisher_id: string;
    currency: string;
    environment: EnvironmentLabel;
    n: string | number;
    total: string | number;
  }>(
    `SELECT u.publisher_id, o.currency, o.environment, count(*) AS n, COALESCE(sum(r.amount_minor), 0) AS total
       FROM refund_requests r
       JOIN order_units u ON u.id = r.unit_id
       JOIN orders o ON o.id = u.order_id
      WHERE r.state IN ${OPEN_REFUND}
      GROUP BY u.publisher_id, o.currency, o.environment`,
  );
  const blocks = new Map<string, ExposureBlock>();
  const byPublisher = new Map<string, ExposureBlock[]>();
  const track = (p: string, b: ExposureBlock): void => {
    const list = byPublisher.get(p) ?? [];
    if (!list.includes(b)) list.push(b);
    byPublisher.set(p, list);
  };
  for (const r of units.rows) {
    const b = blockOf(blocks, r.publisher_id, r.currency, r.environment);
    b.units_captured = Number(r.captured_n);
    b.captured_not_refunded_minor = Number(r.captured_net);
    b.held_count = Number(r.held_n);
    b.held_minor = Number(r.held_sum);
    track(r.publisher_id, b);
  }
  for (const r of refunds.rows) {
    const b = blockOf(blocks, r.publisher_id, r.currency, r.environment);
    b.refunds_open_count = Number(r.n);
    b.refunds_open_minor = Number(r.total);
    track(r.publisher_id, b);
  }
  const liveBy = new Map(live.rows.map((r) => [r.publisher_id, Number(r.n)]));
  return pubs.rows.map((p) => ({
    publisher_id: p.id,
    slug: p.slug,
    display_name: p.display_name,
    status: p.status,
    payee_last4: p.paypal_merchant_id === null ? null : p.paypal_merchant_id.slice(-4),
    payee_verified_at: p.payee_verified_at == null ? null : iso(p.payee_verified_at),
    payee_shared: p.payee_shared,
    settlement: payeeSettlement({
      merchant_id: p.paypal_merchant_id,
      payee_shared: p.payee_shared,
      environment: ctx.environment,
      own_merchant_id: ctx.own_merchant_id,
    }),
    offers_live: liveBy.get(p.id) ?? 0,
    by_currency: (byPublisher.get(p.id) ?? []).sort(
      (a, b) =>
        (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0) ||
        (a.environment < b.environment ? -1 : a.environment > b.environment ? 1 : 0),
    ),
  }));
}
