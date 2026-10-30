// The refunds read model of a publisher (PUB-E1): the units that were refunded, partly refunded, held
// after a possible reversal or reversed, with the sums of the stored refund and reversal ledger rows. The
// publisher id is the actor's and is the only query parameter. No party other than the publisher's own
// units appears and nothing is projected. This module only reads.
import type { AccessOption, Actor, EnvironmentLabel, SqlExecutor } from '@umsbx/contracts';
import { UNIT_STATUS_TEXT } from './sales';
import type { PublisherActor, SaleItem, UnitStatus } from './sales';

export interface RefundRow {
  /** The latest refund or reversal ledger row, else the last change to the unit (UTC, ISO). */
  at: string;
  /** The last 6 characters of the order reference. */
  order_ref6: string;
  items: SaleItem[];
  /** The amount the unit was sold for. */
  amount_minor: number;
  /** The sum of the refund ledger rows. */
  refunded_minor: number;
  /** The sum of the reversal ledger rows. */
  reversed_minor: number;
  currency: string;
  status: UnitStatus;
  status_text: string;
  environment: EnvironmentLabel;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export async function refundsFor(db: SqlExecutor, actor: PublisherActor): Promise<RefundRow[]> {
  if ((actor as Actor).kind !== 'publisher') return [];
  const units = await db.query<{
    id: string;
    order_ref: string;
    currency: string;
    environment: EnvironmentLabel;
    amount_minor: number | string;
    status: UnitStatus;
    refunded: number | string;
    reversed: number | string;
    at: string;
  }>(
    `SELECT u.id, o.order_ref, o.currency, o.environment, u.amount_minor, u.status,
            COALESCE(SUM(l.amount_minor) FILTER (WHERE l.kind = 'refund'), 0) AS refunded,
            COALESCE(SUM(l.amount_minor) FILTER (WHERE l.kind = 'reversal'), 0) AS reversed,
            to_char(COALESCE(MAX(l.created_at) FILTER (WHERE l.kind IN ('refund', 'reversal')), u.updated_at)
                    AT TIME ZONE 'UTC', ${ISO}) AS at
       FROM order_units u
       JOIN orders o ON o.id = u.order_id
       LEFT JOIN ledger_entries l ON l.unit_id = u.id
      WHERE u.publisher_id = $1
      GROUP BY u.id, o.order_ref, o.currency, o.environment, u.amount_minor, u.status, u.updated_at
     HAVING u.status IN ('partially_refunded', 'refunded', 'reversal_suspected', 'reversed')
         OR COUNT(*) FILTER (WHERE l.kind IN ('refund', 'reversal')) > 0
      ORDER BY 9 DESC, u.id DESC`,
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
    refunded_minor: Number(u.refunded),
    reversed_minor: Number(u.reversed),
    currency: u.currency,
    status: u.status,
    status_text: UNIT_STATUS_TEXT[u.status],
    environment: u.environment,
  }));
}

export type { PublisherActor };
