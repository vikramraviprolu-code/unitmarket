// Where the publisher's money is, in one sentence, from stored facts only (PUB-C, D-041, D-065 item 36).
// Pure: no clock, no database. The sentences are the only place that says whether anything was paid.
import type { EnvironmentLabel } from '@umsbx/contracts';

export type SettlementMode = 'dryrun' | 'owner_account' | 'direct' | 'not_set';

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
    "Collected into the UnitMarket team's sandbox test account. Not paid out: sandbox demo; UnitMarket has no payout mechanism.",
  direct: 'Paid by PayPal directly into your own sandbox account.',
  not_set: 'No PayPal account is linked yet.',
};

/** Fixed: the demo takes no commission (no platform fee row exists); 20 percent is planned only. */
export const COMMISSION_LINE = 'No commission in this demo; planned 20 percent, not implemented.';

/**
 * The mode follows this order: a dry run moved nothing; with no merchant id there is no account; the
 * shared flag, or a merchant id equal to the owner's, means the owner's account; anything else is the
 * publisher's own account. "Paid" words appear in the direct mode only.
 */
export function settlementMode(facts: SettlementFacts): Settlement {
  const mode = modeOf(facts);
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
