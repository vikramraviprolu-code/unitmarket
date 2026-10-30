// The statement read model of a publisher (PUB-C, page S5): the publisher's ledger rows, added up per
// currency with publisherBalances from @umsbx/ledger, plus the observed PayPal fee rows. The publisher id
// is the actor's and is the only query parameter. Nothing is projected: every figure is a sum of stored
// rows, and a figure with no rows is null (not reported), never 0. This module only reads.
import { publisherBalances } from '@umsbx/ledger';
import type { EnvironmentLabel, Id, LedgerEntry, SqlExecutor } from '@umsbx/contracts';
import type { PublisherActor } from './sales';
import {
  COMMISSION_LINE,
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

/** One block per currency and stored environment: dry run rows are never added to sandbox rows. */
export interface StatementBlock {
  currency: string;
  environment: EnvironmentLabel;
  sales_minor: number;
  refunds_minor: number;
  reversals_minor: number;
  /** Sales minus refunds minus reversals, as publisherBalances computes it. Fees are not subtracted. */
  net_minor: number;
  /** The sum of the stored PayPal fee rows; null when there are none. */
  paypal_fee_minor: number | null;
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
  return blockCount === 0 && s.mode === 'direct' ? { mode: s.mode, sentence: NOTHING_SOLD_SENTENCE } : s;
}

/**
 * Pure: group the rows by currency and environment, sum each group with publisherBalances, and add the
 * fee rows. The blocks are ordered by currency, then environment, so the order of the rows is irrelevant.
 */
export function buildStatement(
  rows: readonly StatementRow[],
  facts: StatementFacts,
  mismatch_units = 0,
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
      net_minor: bal.net_minor,
      paypal_fee_minor:
        fees.length === 0 ? null : fees.reduce((t, r) => t + r.entry.amount.minor, 0),
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
    commission: COMMISSION_LINE,
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
  );
}
