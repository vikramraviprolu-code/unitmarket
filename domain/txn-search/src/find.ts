// INT-SR1 (SR1.4): operator quick-find. One UNION query over the unique columns (order ref, the last 6 of it,
// PayPal order id, capture id, refund id, receipt id) returns every exact hit, so a 17-character id that sits
// in two columns shows both. Then a name match with SR0's `%` and `_` escaping and its 100-character limit.
// Groups: Orders, Sellers, Offers, Keys, and Buyers for an operator with MFA only; at most 5 each. An
// operator without MFA matches sellers by id or slug only and is shown no name (the rule of withOpsIdentity:
// a name that cannot be shown must not be searchable). No buyer email exists to search (migration 0016).
import type { Actor, SqlExecutor } from '@umsbx/contracts';
import { TxnSearchError } from './cursor';
import { escapeLike } from './sql';
import type { TxnPrincipal } from './scope';

export const FIND_GROUP_MAX = 5;
const Q_MAX = 100;
// \p{Cc}: control characters.
const CONTROL = /\p{Cc}/u;

export type FindColumn =
  'order_ref' | 'order_ref6' | 'provider_order_id' | 'capture_id' | 'refund_id' | 'receipt_id';

export interface FindOrder {
  order_ref: string;
  order_ref6: string;
  matched: FindColumn;
  status: string;
  currency: string;
  total_minor: number;
  environment: string;
  created_at: string;
}
export interface FindSeller {
  publisher_id: string;
  slug: string;
  /** Only with MFA. */
  display_name?: string;
}
export interface FindOffer {
  offer_id: string;
  title: string;
  publisher_id: string;
}
export interface FindKey {
  key_id: string;
  owner_kind: string;
  key_kind: string;
}
export interface FindBuyer {
  buyer_id: string;
  display_name: string;
}
export interface FindResult {
  orders: FindOrder[];
  sellers: FindSeller[];
  offers: FindOffer[];
  keys: FindKey[];
  /** Present only for an operator with MFA. */
  buyers?: FindBuyer[];
}

const ORDERS_SQL = `
WITH hits AS (
  SELECT id AS order_id, 'order_ref' AS matched FROM orders WHERE order_ref = $1
  UNION ALL
  SELECT id, 'order_ref6' FROM orders WHERE length($1) = 6 AND right(order_ref, 6) = $1
  UNION ALL
  SELECT order_id, 'provider_order_id' FROM provider_orders WHERE provider_order_id = $1
  UNION ALL
  SELECT order_id, 'capture_id' FROM order_units WHERE capture_id = $1
  UNION ALL
  SELECT u.order_id, 'refund_id' FROM refund_requests rf JOIN order_units u ON u.id = rf.unit_id WHERE rf.refund_id = $1
  UNION ALL
  SELECT order_id, 'receipt_id' FROM receipts WHERE id = $1
)
SELECT o.order_ref, right(o.order_ref, 6) AS order_ref6, h.matched, o.status, o.currency, o.total_minor,
       o.environment, to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
  FROM hits h JOIN orders o ON o.id = h.order_id
 ORDER BY o.created_at DESC, o.id DESC, h.matched
 LIMIT $2`;

const empty = (mfa: boolean): FindResult => ({
  orders: [],
  sellers: [],
  offers: [],
  keys: [],
  ...(mfa ? { buyers: [] } : {}),
});

export async function quickFind(
  db: SqlExecutor,
  principal: TxnPrincipal,
  q: string,
  _ctx: { now: Date },
): Promise<FindResult> {
  void _ctx; // reserved: the injected clock, for rules that need the time
  if (principal.kind !== 'operator')
    throw new TxnSearchError('forbidden', 'This sign-in cannot search transactions.');
  const mfa = (principal as Extract<Actor, { kind: 'operator' }>).mfa;
  const term = q.trim();
  if (term.length === 0 || term.length > Q_MAX || CONTROL.test(term)) return empty(mfa);
  const like = `%${escapeLike(term.toLowerCase())}%`;

  const orders = await db.query<Record<string, unknown>>(ORDERS_SQL, [term, FIND_GROUP_MAX]);
  const sellers = await db.query<{ id: string; slug: string; display_name: string }>(
    mfa
      ? `SELECT id, slug, display_name FROM publishers
          WHERE id = $1 OR lower(slug) = lower($1) OR lower(display_name) LIKE $2 ESCAPE '\\'
          ORDER BY display_name, id LIMIT $3`
      : `SELECT id, slug, display_name FROM publishers
          WHERE id = $1 OR lower(slug) = lower($1)
          ORDER BY slug, id LIMIT $2`,
    mfa ? [term, like, FIND_GROUP_MAX] : [term, FIND_GROUP_MAX],
  );
  const offers = await db.query<{ id: string; title: string; publisher_id: string }>(
    `SELECT DISTINCT ON (o.id) o.id, a.title, o.publisher_id
       FROM offers o JOIN articles a ON a.id = o.article_id
      WHERE o.id = $1 OR lower(a.title) LIKE $2 ESCAPE '\\'
      ORDER BY o.id, o.version DESC
      LIMIT $3`,
    [term, like, FIND_GROUP_MAX],
  );
  const keys = await db.query<{ id: string; owner_kind: string; key_kind: string }>(
    'SELECT id, owner_kind, key_kind FROM api_keys WHERE id = $1 LIMIT $2',
    [term, FIND_GROUP_MAX],
  );
  const result: FindResult = {
    orders: orders.rows.map((r) => ({
      order_ref: String(r['order_ref']),
      order_ref6: String(r['order_ref6']),
      matched: r['matched'] as FindColumn,
      status: String(r['status']),
      currency: String(r['currency']),
      total_minor: Number(r['total_minor']),
      environment: String(r['environment']),
      created_at: String(r['created_at']),
    })),
    sellers: sellers.rows.map((r) => ({
      publisher_id: r.id,
      slug: r.slug,
      ...(mfa ? { display_name: r.display_name } : {}),
    })),
    offers: offers.rows.map((r) => ({
      offer_id: r.id,
      title: r.title,
      publisher_id: r.publisher_id,
    })),
    keys: keys.rows.map((r) => ({ key_id: r.id, owner_kind: r.owner_kind, key_kind: r.key_kind })),
  };
  if (mfa) {
    const buyers = await db.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM buyers
        WHERE id = $1 OR lower(display_name) LIKE $2 ESCAPE '\\'
        ORDER BY display_name, id LIMIT $3`,
      [term, like, FIND_GROUP_MAX],
    );
    result.buyers = buyers.rows.map((r) => ({ buyer_id: r.id, display_name: r.display_name }));
  }
  return result;
}
