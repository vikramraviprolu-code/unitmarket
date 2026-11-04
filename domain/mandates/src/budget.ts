// API-B (G1, G9): the pure budget rules of a mandate. No database, no clock: the caller passes the row, the
// wanted purchase and "now". The same rules are written as one conditional UPDATE in reserve.ts; this module
// is what explains a refusal and what check_budget reports.

/** The columns of a mandate that the rules read. */
export interface MandateRow {
  id: string;
  buyer_id: string;
  agent_key_id: string;
  currency: string;
  max_total_minor: number | null;
  max_count: number | null;
  max_per_purchase_minor: number | null;
  /** ISO UTC */
  expires_at: string;
  revoked_at: string | null;
  /** held plus committed */
  spent_minor: number;
  used_count: number;
}

export type RefusalReason =
  | 'revoked'
  | 'expired'
  | 'currency_mismatch'
  | 'over_per_purchase'
  | 'cap_exhausted'
  | 'invalid_amount';

export type Verdict = { ok: true } | { ok: false; reason: RefusalReason };

/** The database column is a 32 bit integer, so a larger amount can never be booked. */
export const MAX_AMOUNT_MINOR = 2 ** 31 - 1;

/**
 * Can this purchase be booked now? The order is fixed: revoked, expired (refused at the expiry instant),
 * currency, per-purchase maximum, then the caps. A cap that is not set never refuses.
 */
export function evaluate(
  m: MandateRow,
  want: { amount_minor: number; currency: string },
  now: Date,
): Verdict {
  const a = want.amount_minor;
  if (!Number.isInteger(a) || a < 1 || a > MAX_AMOUNT_MINOR)
    return { ok: false, reason: 'invalid_amount' };
  if (m.revoked_at !== null) return { ok: false, reason: 'revoked' };
  if (now.getTime() >= new Date(m.expires_at).getTime()) return { ok: false, reason: 'expired' };
  if (want.currency !== m.currency) return { ok: false, reason: 'currency_mismatch' };
  if (m.max_per_purchase_minor !== null && a > m.max_per_purchase_minor) {
    return { ok: false, reason: 'over_per_purchase' };
  }
  if (m.max_total_minor !== null && m.spent_minor + a > m.max_total_minor) {
    return { ok: false, reason: 'cap_exhausted' };
  }
  if (m.max_count !== null && m.used_count + 1 > m.max_count) {
    return { ok: false, reason: 'cap_exhausted' };
  }
  return { ok: true };
}

/** What is left, or null for a cap that is not set. */
export function remainingOf(
  m: Pick<MandateRow, 'max_total_minor' | 'max_count' | 'spent_minor' | 'used_count'>,
): {
  remaining_total_minor: number | null;
  remaining_count: number | null;
} {
  return {
    remaining_total_minor:
      m.max_total_minor === null ? null : Math.max(0, m.max_total_minor - m.spent_minor),
    remaining_count: m.max_count === null ? null : Math.max(0, m.max_count - m.used_count),
  };
}

/**
 * What an agent without a usable cap tells its buyer. A cap is stated as money, as a number of purchases,
 * or both, with an expiry; the buyer sets it in UnitMarket. The agent never sets or widens its own cap.
 */
export const ASK_BUYER_TEXT =
  'You have no spending cap yet. Ask your buyer to set one in UnitMarket: a limit on money, a limit on the ' +
  'number of purchases, or both, and an expiry date. Until the buyer sets it, you cannot buy anything.';
