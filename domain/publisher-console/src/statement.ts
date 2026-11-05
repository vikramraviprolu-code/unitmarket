// The statement read model of a publisher (PUB-C, page S5): the publisher's ledger rows, added up per
// currency with publisherBalances from @umsbx/ledger, plus the observed PayPal fee rows. The publisher id
// is the actor's and is the only query parameter. Nothing is projected: every figure is a sum of stored
// rows, and a figure with no rows is null (not reported), never 0. This module only reads.
import { publisherBalances } from '@umsbx/ledger';
import type { EnvironmentLabel, Id, LedgerEntry, SqlExecutor } from '@umsbx/contracts';
import type { PublisherActor } from './sales';
import {
  COMMISSION_LINE,
  FEE_ON_TOP_LINE,
  NOTHING_SOLD_SENTENCE,
  blockSettlement,
  payeeSettlement,
} from './settlement';
import type { Settlement } from './settlement';

export type StatementKind = 'sale' | 'refund' | 'reversal' | 'paypal_fee';

export interface StatementLine {
  /** When the ledger row was written (UTC, ISO). */
  at: string;
  /** The last 6 characters of the order reference the row belongs to. */
  order_ref6: string;
  kind: StatementKind;
  amount_minor: number;
}

/**
 * POB-M1 (D-089): what the fee on top and the payout add to a block. Null where no unit of the block has a split (sold before the
 * fee existed). Every figure is a sum of stored rows (ledger fee, payable and their reversals; payouts; settlements).
 */
export interface BlockMoney {
  /** UnitMarket fee on top (paid by the customer): fee rows minus fee reversals. */
  fee_minor: number;
  /** Owed to the publisher: payable rows minus payable reversals, whether or not it was paid out yet. */
  owed_minor: number;
  /** Paid out to the publisher: payouts that are sent or confirmed. */
  paid_out_minor: number;
  /** Open adjustments: the publisher share of refunds booked after payout, not yet netted off a payout. */
  adjustment_minor: number;
  /** Next payout: what is owed and not in a payout that went out, less the open adjustments, never below 0. */
  net_minor: number;
}

/** One block per currency and stored environment: dry run rows are never added to sandbox rows. */
export interface StatementBlock {
  currency: string;
  environment: EnvironmentLabel;
  sales_minor: number;
  refunds_minor: number;
  reversals_minor: number;
  /** The number of units with a ledger sale row (the paid units of the sales page totals row). */
  units_sold: number;
  /** Sales minus refunds minus reversals, as publisherBalances computes it. Fees are not subtracted. */
  net_minor: number;
  /** The sum of the stored PayPal fee rows; null when there are none. */
  paypal_fee_minor: number | null;
  /** POB-M1: the fee on top, what is owed, what was paid out, adjustments and the next payout. Null for old sales only. */
  money: BlockMoney | null;
  settlement: Settlement;
  lines: StatementLine[];
}

export interface PublisherStatement {
  /** The label for a statement with no rows: the app environment. */
  environment: EnvironmentLabel;
  /** The settlement sentence for that environment (a block carries its own). */
  settlement: Settlement;
  commission: string;
  /**
   * Units whose amount disagreed with the quote (status mismatch). The sales page lists them; the ledger
   * has no sale row for them, so no block adds them up (assumption 30 awaits an owner decision).
   */
  mismatch_units: number;
  blocks: StatementBlock[];
}

export interface StatementFacts {
  merchant_id: string | null;
  payee_shared: boolean;
  own_merchant_id: string | null;
  environment: EnvironmentLabel;
}

/** One ledger row of the publisher, with the order it belongs to. */
export interface StatementRow {
  order_ref: string;
  /** The payee stored on the unit (order_units.payee_merchant_id): where PayPal was told to send this sale. */
  payee_merchant_id: string;
  entry: LedgerEntry;
}

const KINDS: readonly StatementKind[] = ['sale', 'refund', 'reversal', 'paypal_fee'];

const KIND_RANK: Record<StatementKind, number> = { sale: 0, refund: 1, reversal: 2, paypal_fee: 3 };

// Oldest first. Rows written at the same instant read in a fixed order: by order, then the sale before
// what changed it, then the row id, so the same rows always give the same lines.
function byTimeThenOrder(a: StatementRow, b: StatementRow): number {
  const x = a.entry;
  const y = b.entry;
  if (x.created_at !== y.created_at) return x.created_at < y.created_at ? -1 : 1;
  if (a.order_ref !== b.order_ref) return a.order_ref < b.order_ref ? -1 : 1;
  const rank = KIND_RANK[x.kind as StatementKind] - KIND_RANK[y.kind as StatementKind];
  if (rank !== 0) return rank;
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

// The statement-level sentence: the account as it is now. With no sales, direct mode says nothing sold yet.
function emptyOrCurrent(blockCount: number, facts: StatementFacts): Settlement {
  const s = payeeSettlement(facts);
  return blockCount === 0 && s.mode === 'direct'
    ? { mode: s.mode, sentence: NOTHING_SOLD_SENTENCE }
    : s;
}

/**
 * Pure: group the rows by currency and environment, sum each group with publisherBalances, and add the
 * fee rows. The blocks are ordered by currency, then environment, so the order of the rows is irrelevant.
 */
export function buildStatement(
  rows: readonly StatementRow[],
  facts: StatementFacts,
  mismatch_units = 0,
  money: ReadonlyMap<string, BlockMoney> = new Map(),
): PublisherStatement {
  const groups = new Map<
    string,
    { currency: string; environment: EnvironmentLabel; rows: StatementRow[] }
  >();
  for (const r of rows) {
    if (!KINDS.includes(r.entry.kind as StatementKind)) continue;
    const key = `${r.entry.amount.currency}\u0000${r.entry.environment}`;
    const g = groups.get(key) ?? {
      currency: r.entry.amount.currency,
      environment: r.entry.environment,
      rows: [],
    };
    g.rows.push(r);
    groups.set(key, g);
  }
  const blocks = [...groups.keys()].sort().map((key): StatementBlock => {
    const g = groups.get(key)!;
    const bal = publisherBalances(
      g.rows.map((r) => ({ publisher_id: 'self' as Id, entry: r.entry })),
    )[0]!;
    const fees = g.rows.filter((r) => r.entry.kind === 'paypal_fee');
    const lines = [...g.rows].sort(byTimeThenOrder).map((r): StatementLine => ({
      at: r.entry.created_at,
      order_ref6: r.order_ref.slice(-6),
      kind: r.entry.kind as StatementKind,
      amount_minor: r.entry.amount.minor,
    }));
    return {
      currency: g.currency,
      environment: g.environment,
      sales_minor: bal.sold_minor,
      refunds_minor: bal.refunded_minor,
      reversals_minor: bal.reversed_minor,
      units_sold: new Set(g.rows.filter((r) => r.entry.kind === 'sale').map((r) => r.entry.unit_id))
        .size,
      net_minor: bal.net_minor,
      paypal_fee_minor:
        fees.length === 0 ? null : fees.reduce((t, r) => t + r.entry.amount.minor, 0),
      money: money.get(key) ?? null,
      settlement: blockSettlement({
        environment: g.environment,
        payees: g.rows.map((r) => r.payee_merchant_id),
        own_merchant_id: facts.own_merchant_id,
        current_merchant_id: facts.merchant_id,
        payee_shared: facts.payee_shared,
      }),
      lines,
    };
  });
  return {
    environment: facts.environment,
    settlement: emptyOrCurrent(blocks.length, facts),
    commission: blocks.some((b) => (b.money?.fee_minor ?? 0) > 0)
      ? FEE_ON_TOP_LINE
      : COMMISSION_LINE,
    mismatch_units,
    blocks,
  };
}

/** What the composition knows and the database does not: the owner's merchant id and the app environment. */
export interface StatementContext {
  own_merchant_id: string | null;
  environment: EnvironmentLabel;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const moneyKey = (currency: string, environment: string): string =>
  `${currency}\u0000${environment}`;

/**
 * POB-M1: the money block figures of a publisher, per currency and environment. Only blocks that have a payable row are in the
 * map. Reads only.
 */
async function moneyFor(db: SqlExecutor, publisher_id: string): Promise<Map<string, BlockMoney>> {
  const ledger = await db.query<{
    currency: string;
    environment: EnvironmentLabel;
    fee: string | number;
    fee_rev: string | number;
    payable: string | number;
    payable_rev: string | number;
    payable_rows: string | number;
  }>(
    `SELECT l.currency, l.environment,
            coalesce(sum(l.amount_minor) FILTER (WHERE l.kind = 'fee'), 0) AS fee,
            coalesce(sum(l.amount_minor) FILTER (WHERE l.kind = 'fee_reversal'), 0) AS fee_rev,
            coalesce(sum(l.amount_minor) FILTER (WHERE l.kind = 'payable'), 0) AS payable,
            coalesce(sum(l.amount_minor) FILTER (WHERE l.kind = 'payable_reversal'), 0) AS payable_rev,
            count(*) FILTER (WHERE l.kind = 'payable') AS payable_rows
       FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id
      WHERE u.publisher_id = $1
        AND l.kind IN ('fee', 'payable', 'fee_reversal', 'payable_reversal', 'payout_adjustment')
      GROUP BY l.currency, l.environment`,
    [publisher_id],
  );
  // Open adjustments, review B1: only those whose source payout went out (sent or confirmed) or has no source row. One whose
  // payout failed or was cancelled is void (its unit is paid again from the reduced ledger net); one still sending waits.
  const adjusted = await db.query<{ currency: string; environment: string; n: string | number }>(
    `SELECT l.currency, l.environment, coalesce(sum(l.amount_minor), 0) AS n
       FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id
      WHERE u.publisher_id = $1 AND l.kind = 'payout_adjustment'
        AND NOT EXISTS (SELECT 1 FROM payout_adjustment_sources s JOIN payouts sp ON sp.id = s.payout_id
                         WHERE s.adjustment_entry_id = l.id AND sp.state IN ('sending', 'failed', 'cancelled'))
      GROUP BY l.currency, l.environment`,
    [publisher_id],
  );
  const paid = await db.query<{ currency: string; environment: string; n: string | number }>(
    `SELECT currency, environment, coalesce(sum(amount_minor), 0) AS n FROM payouts
      WHERE publisher_id = $1 AND state IN ('sent', 'confirmed') GROUP BY currency, environment`,
    [publisher_id],
  );
  const settled = await db.query<{ currency: string; environment: string; n: string | number }>(
    `SELECT p.currency, p.environment, coalesce(sum(s.amount_minor), 0) AS n
       FROM adjustment_settlements s JOIN payouts p ON p.id = s.payout_id
      WHERE p.publisher_id = $1 AND s.live GROUP BY p.currency, p.environment`,
    [publisher_id],
  );
  // Payable not yet in a payout that went out (a due or failed payout, or none): the next payout before adjustments.
  const unpaid = await db.query<{ currency: string; environment: string; n: string | number }>(
    `SELECT o.currency, o.environment, coalesce(sum(pay.net), 0) AS n
       FROM order_units u
       JOIN orders o ON o.id = u.order_id
       CROSS JOIN LATERAL (
         SELECT coalesce(sum(l.amount_minor) FILTER (WHERE l.kind = 'payable'), 0)
                - coalesce(sum(l.amount_minor) FILTER (WHERE l.kind = 'payable_reversal'), 0) AS net,
                count(*) FILTER (WHERE l.kind = 'payable') AS rows
           FROM ledger_entries l WHERE l.unit_id = u.id) pay
      WHERE u.publisher_id = $1 AND pay.rows > 0
        AND NOT EXISTS (SELECT 1 FROM payout_items i JOIN payouts p ON p.id = i.payout_id
                         WHERE i.order_unit_id = u.id AND i.live AND p.state IN ('sending', 'sent', 'confirmed'))
      GROUP BY o.currency, o.environment`,
    [publisher_id],
  );
  const by = (
    rows: { currency: string; environment: string; n: string | number }[],
  ): Map<string, number> =>
    new Map(rows.map((r) => [moneyKey(r.currency, r.environment), Number(r.n)]));
  const paidBy = by(paid.rows);
  const settledBy = by(settled.rows);
  const adjustedBy = by(adjusted.rows);
  const unpaidBy = by(unpaid.rows);
  const out = new Map<string, BlockMoney>();
  for (const r of ledger.rows) {
    if (Number(r.payable_rows) === 0) continue;
    const key = moneyKey(r.currency, r.environment);
    const adjustment = (adjustedBy.get(key) ?? 0) - (settledBy.get(key) ?? 0);
    out.set(key, {
      fee_minor: Number(r.fee) - Number(r.fee_rev),
      owed_minor: Number(r.payable) - Number(r.payable_rev),
      paid_out_minor: paidBy.get(key) ?? 0,
      adjustment_minor: adjustment,
      net_minor: Math.max(0, (unpaidBy.get(key) ?? 0) - adjustment),
    });
  }
  return out;
}

export async function statementFor(
  db: SqlExecutor,
  actor: PublisherActor,
  ctx: StatementContext,
): Promise<PublisherStatement> {
  const empty = { merchant_id: null, payee_shared: false, ...ctx };
  if (actor.kind !== 'publisher') return buildStatement([], empty);
  const payee = await db.query<{ paypal_merchant_id: string | null; payee_shared: boolean }>(
    'SELECT paypal_merchant_id, payee_shared FROM publishers WHERE id = $1',
    [actor.publisher_id],
  );
  const p = payee.rows[0];
  const ledger = await db.query<{
    id: string;
    unit_id: string;
    capture_id: string;
    kind: LedgerEntry['kind'];
    amount_minor: number | string;
    currency: string;
    refund_id: string | null;
    ref_entry_id: string | null;
    environment: EnvironmentLabel;
    at: string;
    order_ref: string;
    payee_merchant_id: string;
  }>(
    `SELECT l.id, l.unit_id, l.capture_id, l.kind, l.amount_minor, l.currency, l.refund_id, l.ref_entry_id,
            l.environment, o.order_ref, u.payee_merchant_id,
            to_char(l.created_at AT TIME ZONE 'UTC', ${ISO}) AS at
       FROM ledger_entries l
       JOIN order_units u ON u.id = l.unit_id
       JOIN orders o ON o.id = u.order_id
      WHERE u.publisher_id = $1 AND l.kind IN ('sale', 'refund', 'reversal', 'paypal_fee')
      ORDER BY l.created_at, l.id`,
    [actor.publisher_id],
  );
  const rows = ledger.rows.map((r): StatementRow => ({
    order_ref: r.order_ref,
    payee_merchant_id: r.payee_merchant_id,
    entry: {
      id: r.id,
      unit_id: r.unit_id,
      capture_id: r.capture_id,
      kind: r.kind,
      amount: { currency: r.currency, minor: Number(r.amount_minor) },
      refund_id: r.refund_id,
      ref_entry_id: r.ref_entry_id,
      created_at: r.at,
      environment: r.environment,
    },
  }));
  const held = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM order_units WHERE publisher_id = $1 AND status = 'mismatch'`,
    [actor.publisher_id],
  );
  return buildStatement(
    rows,
    {
      merchant_id: p?.paypal_merchant_id ?? null,
      payee_shared: p?.payee_shared ?? false,
      ...ctx,
    },
    Number(held.rows[0]?.n ?? 0),
    await moneyFor(db, actor.publisher_id),
  );
}
