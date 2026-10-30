// Where the publisher's money is, in one sentence, from stored facts only (PUB-C, D-041, D-065 item 36).
// Pure: no clock, no database. The sentences are the only place that says whether anything was paid.
import type { EnvironmentLabel } from '@umsbx/contracts';

export type SettlementMode = 'dryrun' | 'owner_account' | 'direct' | 'not_set' | 'mixed';

export interface SettlementFacts {
  /** The merchant id stored for the publisher, or null when none is set. */
  merchant_id: string | null;
  /** The explicit payee_shared flag of the publisher row. */
  payee_shared: boolean;
  /** The stored environment of the rows the sentence is about (or the app environment when there are none). */
  environment: EnvironmentLabel;
  /** The owner's own sandbox merchant id from configuration; null when none is configured. */
  own_merchant_id: string | null;
}

export interface Settlement {
  mode: SettlementMode;
  sentence: string;
}

export const SETTLEMENT_SENTENCE: Record<SettlementMode, string> = {
  dryrun: 'Dry run: no money moved.',
  owner_account:
    "In this sandbox demo every payment is received in the UnitMarket team's one test account. Nothing is paid out to the publisher.",
  direct: 'Paid by PayPal directly into your own sandbox account.',
  not_set: 'No PayPal account is linked yet.',
  mixed:
    'These sales were received in more than one account, so no single sentence describes them.',
};

/**
 * The same words for a page that is about the publisher's account now (home, payout page, operator
 * page), not about sales already made: the direct mode is stated as what happens to new sales.
 */
export const PAYEE_DIRECT_SENTENCE =
  'New sales are paid by PayPal directly into your own sandbox account.';

/** A statement with no sales says so; it never says "Paid by PayPal" about nothing. */
export const NOTHING_SOLD_SENTENCE = 'Nothing sold yet.';

/** Fixed: the demo takes no commission (no platform fee row exists); 20 percent is planned only. */
export const COMMISSION_LINE = 'No commission in this demo.';

/**
 * The mode follows this order: a dry run moved nothing; with no merchant id there is no account; the
 * shared flag, or a merchant id equal to the owner's, means the owner's account; anything else is the
 * publisher's own account. "Paid" words appear in the direct mode only.
 */
export function settlementMode(facts: SettlementFacts): Settlement {
  const mode = modeOf(facts);
  return { mode, sentence: SETTLEMENT_SENTENCE[mode] };
}

/**
 * One sentence for the publisher's account as it is now, for pages that are not about a block of sales.
 * It never reads as proof that money went anywhere.
 */
export function payeeSettlement(facts: SettlementFacts): Settlement {
  const mode = modeOf(facts);
  return { mode, sentence: mode === 'direct' ? PAYEE_DIRECT_SENTENCE : SETTLEMENT_SENTENCE[mode] };
}

/** What the rows of one statement block say about where the money went (stored facts only). */
export interface BlockFacts {
  environment: EnvironmentLabel;
  /** The payee stored on each unit of the block (order_units.payee_merchant_id), one entry per row. */
  payees: readonly string[];
  /** The owner's own sandbox merchant id from configuration; null when none is configured. */
  own_merchant_id: string | null;
  /** The publisher's current payee and shared flag: used only to recognise a stored payee as the shared owner account. */
  current_merchant_id: string | null;
  payee_shared: boolean;
}

/**
 * PER BLOCK, from the payees stored on the block's own units, never from the publisher's current payee
 * alone: a later switch cannot relabel earlier sales. A stored payee is the owner's account when it
 * equals the owner id, or when it equals the current payee and that payee is flagged shared. More than
 * one distinct payee is `mixed`, never `direct`.
 */
export function blockSettlement(f: BlockFacts): Settlement {
  if (f.environment === 'dryrun') return { mode: 'dryrun', sentence: SETTLEMENT_SENTENCE.dryrun };
  const distinct = [...new Set(f.payees)];
  const isOwner = (id: string): boolean =>
    (f.own_merchant_id !== null && id === f.own_merchant_id) ||
    (f.payee_shared && f.current_merchant_id !== null && id === f.current_merchant_id);
  let mode: SettlementMode;
  if (distinct.length === 0) mode = 'not_set';
  else if (distinct.length > 1) mode = 'mixed';
  else mode = isOwner(distinct[0]!) ? 'owner_account' : 'direct';
  return { mode, sentence: SETTLEMENT_SENTENCE[mode] };
}

function modeOf(f: SettlementFacts): SettlementMode {
  if (f.environment === 'dryrun') return 'dryrun';
  if (f.merchant_id === null) return 'not_set';
  if (f.payee_shared || (f.own_merchant_id !== null && f.merchant_id === f.own_merchant_id)) {
    return 'owner_account';
  }
  return 'direct';
}
