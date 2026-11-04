// The operator's booked totals per stored environment and currency (MC2-L7, D-084 item 5): the sum of
// ledger sale rows, the sum of ledger refund rows, and the exposure the publishers page already shows
// (paid and not refunded, plus held), added over all publishers. Read only. Nothing is converted here: a
// row is always one currency, and a dry run row is never added to a sandbox row. The reporting view that
// converts these figures lives in the web app and goes through the exchange rate engine.
import type { Actor, EnvironmentLabel, SqlExecutor } from '@umsbx/contracts';
import { CAPTURED, HELD } from './exposure';

export interface OpsTotalsRow {
  environment: EnvironmentLabel;
  currency: string;
  /** Sum of ledger sale rows. */
  sales_minor: number;
  /** Sum of ledger refund rows. */
  refunds_minor: number;
  /** Units captured and not refunded, plus units held (pending, reversal suspected, mismatch). */
  exposure_minor: number;
}

/** Operators only; any other actor gets null. The second factor is not needed: orders are already listed. */
export async function opsTotalsFor(db: SqlExecutor, actor: Actor): Promise<OpsTotalsRow[] | null> {
  if (actor.kind !== 'operator') return null;
  const ledger = await db.query<{
    currency: string;
    environment: EnvironmentLabel;
    sales: string | number;
    refunds: string | number;
  }>(
    `SELECT currency, environment,
            COALESCE(sum(amount_minor) FILTER (WHERE kind = 'sale'), 0) AS sales,
            COALESCE(sum(amount_minor) FILTER (WHERE kind = 'refund'), 0) AS refunds
       FROM ledger_entries
      GROUP BY currency, environment`,
  );
  const units = await db.query<{
    currency: string;
    environment: EnvironmentLabel;
    captured_net: string | number;
    held_sum: string | number;
  }>(
    `SELECT o.currency, o.environment,
            COALESCE(sum(u.amount_minor - u.refunded_minor) FILTER (WHERE u.status IN ${CAPTURED}), 0) AS captured_net,
            COALESCE(sum(u.amount_minor) FILTER (WHERE u.status IN ${HELD}), 0) AS held_sum
       FROM order_units u JOIN orders o ON o.id = u.order_id
      GROUP BY o.currency, o.environment`,
  );
  const rows = new Map<string, OpsTotalsRow>();
  const rowOf = (currency: string, environment: EnvironmentLabel): OpsTotalsRow => {
    const key = `${environment}\u0000${currency}`;
    let r = rows.get(key);
    if (r === undefined) {
      r = { environment, currency, sales_minor: 0, refunds_minor: 0, exposure_minor: 0 };
      rows.set(key, r);
    }
    return r;
  };
  for (const l of ledger.rows) {
    const r = rowOf(l.currency, l.environment);
    r.sales_minor = Number(l.sales);
    r.refunds_minor = Number(l.refunds);
  }
  for (const u of units.rows) {
    rowOf(u.currency, u.environment).exposure_minor = Number(u.captured_net) + Number(u.held_sum);
  }
  return [...rows.values()]
    .filter((r) => r.sales_minor !== 0 || r.refunds_minor !== 0 || r.exposure_minor !== 0)
    .sort(
      (a, b) =>
        (a.environment < b.environment ? -1 : a.environment > b.environment ? 1 : 0) ||
        (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0),
    );
}
