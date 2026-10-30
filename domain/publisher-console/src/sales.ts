// The sales read model of a publisher (PUB-C, page S4): one row per order unit of the publisher, read
// from stored rows. The publisher id is the actor's and is the only query parameter; there is no
// other id to pass. Nothing here names a buyer. This module only reads.
import type { AccessOption, Actor, EnvironmentLabel, SqlExecutor } from '@umsbx/contracts';

export type PublisherActor = Extract<Actor, { kind: 'publisher' }>;

export type UnitStatus =
  | 'expected'
  | 'captured_verified'
  | 'pending'
  | 'declined'
  | 'mismatch'
  | 'partially_refunded'
  | 'refunded'
  | 'reversal_suspected'
  | 'reversed';

/** D-051: "Not charged" is the word for a declined payment and for nothing else. */
export const UNIT_STATUS_TEXT: Record<UnitStatus, string> = {
  captured_verified: 'Paid',
  pending: 'Payment pending at PayPal',
  partially_refunded: 'Partly refunded',
  refunded: 'Refunded',
  reversal_suspected: 'On hold: payment being checked',
  reversed: 'Reversed',
  declined: 'Not charged',
  mismatch: 'On hold: under review',
  expected: 'Awaiting payment',
};

export interface SaleItem {
  title: string;
  option: AccessOption;
}

export interface SaleRow {
  /** captured_verified_at, else created_at (UTC, ISO). */
  at: string;
  /** The last 6 characters of the order reference. */
  order_ref6: string;
  /** The articles of the unit, with the access option bought. */
  items: SaleItem[];
  amount_minor: number;
  currency: string;
  /** Only when PayPal reported a fee and it is stored; otherwise null (shown as not reported). */
  paypal_fee_minor: number | null;
  status: UnitStatus;
  status_text: string;
  environment: EnvironmentLabel;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export async function salesFor(db: SqlExecutor, actor: PublisherActor): Promise<SaleRow[]> {
  if (actor.kind !== 'publisher') return [];
  const units = await db.query<{
    id: string;
    order_ref: string;
    currency: string;
    environment: EnvironmentLabel;
    amount_minor: number | string;
    paypal_fee_minor: number | string | null;
    status: UnitStatus;
    at: string;
  }>(
    `SELECT u.id, o.order_ref, o.currency, o.environment, u.amount_minor, u.paypal_fee_minor, u.status,
            to_char(COALESCE(u.captured_verified_at, u.created_at) AT TIME ZONE 'UTC', ${ISO}) AS at
       FROM order_units u JOIN orders o ON o.id = u.order_id
      WHERE u.publisher_id = $1
      ORDER BY COALESCE(u.captured_verified_at, u.created_at) DESC, u.id DESC`,
    [actor.publisher_id],
  );
  const items = await db.query<{ unit_id: string; title: string; option: AccessOption }>(
    `SELECT e.unit_id, a.title, e.option
       FROM entitlements e
       JOIN order_units u ON u.id = e.unit_id
       JOIN articles a ON a.id = e.article_id
      WHERE u.publisher_id = $1
      ORDER BY e.unit_id, e.article_id`,
    [actor.publisher_id],
  );
  const byUnit = new Map<string, SaleItem[]>();
  for (const i of items.rows) {
    const list = byUnit.get(i.unit_id) ?? [];
    list.push({ title: i.title, option: i.option });
    byUnit.set(i.unit_id, list);
  }
  return units.rows.map((u) => ({
    at: u.at,
    order_ref6: u.order_ref.slice(-6),
    items: byUnit.get(u.id) ?? [],
    amount_minor: Number(u.amount_minor),
    currency: u.currency,
    paypal_fee_minor: u.paypal_fee_minor === null ? null : Number(u.paypal_fee_minor),
    status: u.status,
    status_text: UNIT_STATUS_TEXT[u.status],
    environment: u.environment,
  }));
}
