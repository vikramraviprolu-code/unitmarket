// POB-M1 (D-089): the split of a sale in the ledger. The sale row stays the gross buyer total, so every old figure holds
// (INV1, the unit balance, the statement). Beside it, once per capture, a `fee` row and a `payable` row (the publisher's
// share) add up to the sale. A refund books a `fee_reversal` and a `payable_reversal` that add up to the refund: the
// running total of the fee reversed is the fee share of the running total refunded, rounded half away from zero, so the
// parts always sum to each refund and, over all refunds, the fee reversed ends at exactly the fee.
import type { CoreDeps, Id, LedgerEntry, SqlExecutor } from '@umsbx/contracts';
import { LedgerRuleError, appendLedgerEntry } from './ledger';

type PartsDeps = Pick<CoreDeps, 'clock' | 'ids' | 'environment'>;

/** The parts of a unit, copied from its offers when the order was created (order_unit_parts). Tax is reserved at 0. */
export interface UnitParts {
  seller_minor: number;
  fee_minor: number;
}

export interface RefundSplit {
  fee_minor: number;
  payable_minor: number;
}

/** The parts row of a unit, or null for a unit that was sold before the fee existed. */
export async function getUnitParts(db: SqlExecutor, unit_id: Id): Promise<UnitParts | null> {
  const r = await db.query<{ seller_minor: number | string; fee_minor: number | string }>(
    'SELECT seller_minor, fee_minor FROM order_unit_parts WHERE unit_id = $1',
    [unit_id],
  );
  const row = r.rows[0];
  return row === undefined
    ? null
    : { seller_minor: Number(row.seller_minor), fee_minor: Number(row.fee_minor) };
}

/** floor(x / 2) rounding helper: round half up of (a / b) for a >= 0 and b > 0, exact in BigInt. */
const roundDiv = (a: bigint, b: bigint): bigint => (2n * a + b) / (2n * b);

/**
 * How one refund splits. `refunded_before_minor` is what was refunded on the unit before this refund. The fee reversed
 * by all refunds up to a running total R is round_half_away(R * fee / (seller + fee)); this refund reverses the step from
 * the previous total to the new one, and the rest is payable. Throws RangeError for amounts that cannot be.
 */
export function splitRefund(
  parts: UnitParts,
  refunded_before_minor: number,
  amount_minor: number,
): RefundSplit {
  const total = parts.seller_minor + parts.fee_minor;
  if (
    !Number.isSafeInteger(parts.seller_minor) ||
    !Number.isSafeInteger(parts.fee_minor) ||
    parts.seller_minor < 0 ||
    parts.fee_minor < 0 ||
    total <= 0 ||
    !Number.isSafeInteger(refunded_before_minor) ||
    refunded_before_minor < 0 ||
    !Number.isSafeInteger(amount_minor) ||
    amount_minor < 1 ||
    refunded_before_minor + amount_minor > total
  ) {
    throw new RangeError('splitRefund: the refund does not fit the unit');
  }
  const T = BigInt(total);
  const F = BigInt(parts.fee_minor);
  const after = BigInt(refunded_before_minor + amount_minor);
  const before = BigInt(refunded_before_minor);
  const fee = Number(roundDiv(after * F, T) - roundDiv(before * F, T));
  return { fee_minor: fee, payable_minor: amount_minor - fee };
}

/**
 * Books the fee and payable rows of a captured unit, against the sale row that was just booked. A unit with no parts row
 * (sold before the fee existed) gets nothing and null is returned. A replay adds nothing (the ledger key says so). The
 * parts must add up to the sale: a caller bug throws LedgerRuleError and nothing more is written.
 */
export async function bookSaleParts(
  tx: SqlExecutor,
  d: PartsDeps,
  i: { unit_id: Id; capture_id: string; sale_entry_id: Id },
): Promise<UnitParts | null> {
  const parts = await getUnitParts(tx, i.unit_id);
  if (parts === null) return null;
  const sale = (
    await tx.query<{ amount_minor: number | string; currency: string }>(
      "SELECT amount_minor, currency FROM ledger_entries WHERE id = $1 AND capture_id = $2 AND kind = 'sale'",
      [i.sale_entry_id, i.capture_id],
    )
  ).rows[0];
  if (sale === undefined)
    throw new LedgerRuleError('the sale to split is not booked for this capture');
  if (Number(sale.amount_minor) !== parts.seller_minor + parts.fee_minor) {
    throw new LedgerRuleError(
      `parts ${String(parts.seller_minor)} + ${String(parts.fee_minor)} do not add up to the sale ${String(sale.amount_minor)}`,
    );
  }
  if (parts.fee_minor > 0) {
    await appendLedgerEntry(tx, d, {
      unit_id: i.unit_id,
      capture_id: i.capture_id,
      kind: 'fee',
      amount: { currency: sale.currency, minor: parts.fee_minor },
      refund_id: null,
      ref_entry_id: i.sale_entry_id,
    });
  }
  await appendLedgerEntry(tx, d, {
    unit_id: i.unit_id,
    capture_id: i.capture_id,
    kind: 'payable',
    amount: { currency: sale.currency, minor: parts.seller_minor },
    refund_id: null,
    ref_entry_id: i.sale_entry_id,
  });
  return parts;
}

/**
 * Books the reversals of one refund (already booked as a `refund` row with this refund id): one row for the fee part
 * and one for the payable part, each only when above 0. A unit with no payable row (sold before the fee existed) gets
 * nothing. The parts must add up to the refund row; a replay with the same parts adds nothing and one with other parts
 * is a conflicting replay (LedgerRuleError), never a silent second booking.
 */
export async function bookRefundParts(
  tx: SqlExecutor,
  d: PartsDeps,
  i: {
    unit_id: Id;
    capture_id: string;
    refund_id: string;
    ref_entry_id: Id | null;
    split: RefundSplit;
  },
): Promise<{ fee_entry_id: Id | null; payable_entry_id: Id | null }> {
  const has = await tx.query(
    "SELECT 1 FROM ledger_entries WHERE capture_id = $1 AND kind = 'payable'",
    [i.capture_id],
  );
  if (has.rows.length === 0) return { fee_entry_id: null, payable_entry_id: null };
  const refund = (
    await tx.query<{ amount_minor: number | string; currency: string; id: string }>(
      "SELECT id, amount_minor, currency FROM ledger_entries WHERE capture_id = $1 AND kind = 'refund' AND refund_id = $2",
      [i.capture_id, i.refund_id],
    )
  ).rows[0];
  if (refund === undefined) throw new LedgerRuleError(`refund ${i.refund_id} is not booked yet`);
  if (i.split.fee_minor + i.split.payable_minor !== Number(refund.amount_minor)) {
    throw new LedgerRuleError(
      `the parts of refund ${i.refund_id} (${String(i.split.fee_minor)} + ${String(i.split.payable_minor)}) do not add up to ${String(refund.amount_minor)}`,
    );
  }
  const idOf = async (
    kind: 'fee_reversal' | 'payable_reversal',
    minor: number,
  ): Promise<Id | null> => {
    if (minor === 0) return null;
    const r = await appendLedgerEntry(tx, d, {
      unit_id: i.unit_id,
      capture_id: i.capture_id,
      kind,
      amount: { currency: refund.currency, minor },
      refund_id: i.refund_id,
      ref_entry_id: i.ref_entry_id,
    });
    return r.ok ? r.value.id : r.error.existing_entry_id;
  };
  const fee_entry_id = await idOf('fee_reversal', i.split.fee_minor);
  const payable_entry_id = await idOf('payable_reversal', i.split.payable_minor);
  return { fee_entry_id, payable_entry_id };
}

export interface UnitSplit {
  fee_minor: number;
  payable_minor: number;
  fee_reversed_minor: number;
  payable_reversed_minor: number;
  /** Publisher share of refunds booked after it was paid out (kind payout_adjustment). */
  adjustment_minor: number;
}

/** Pure sums of the new kinds over the rows of one unit (or one capture). The old sums are unitBalance's. */
export function unitSplit(entries: readonly LedgerEntry[]): UnitSplit {
  const out: UnitSplit = {
    fee_minor: 0,
    payable_minor: 0,
    fee_reversed_minor: 0,
    payable_reversed_minor: 0,
    adjustment_minor: 0,
  };
  for (const e of entries) {
    if (e.kind === 'fee') out.fee_minor += e.amount.minor;
    else if (e.kind === 'payable') out.payable_minor += e.amount.minor;
    else if (e.kind === 'fee_reversal') out.fee_reversed_minor += e.amount.minor;
    else if (e.kind === 'payable_reversal') out.payable_reversed_minor += e.amount.minor;
    else if (e.kind === 'payout_adjustment') out.adjustment_minor += e.amount.minor;
  }
  return out;
}
