// POB-I1 (D-089, review finding): the fee the buyer pays on top of the publisher's price, as a PORT of the
// web import. The import defines its own interface; composition wires the fee setting (POB-M1, D-096) into it
// through `importFeeFrom` (POB-G), so the review and the publish step read the same rate.
//
// The fee shown at review is information only: it is never stored on an item. At publish (import-publish.ts) the
// offer is listed at the publisher price plus this fee and the split is recorded beside it (offer_price_parts).
import type { FeePolicy } from './fee';

export interface ImportFeePolicy {
  /**
   * The rate this policy was built at, in basis points, recorded with the parts of an offer. A policy that charges a
   * fee but names no rate cannot publish (fee_unavailable): a split with no rate is never written.
   */
  readonly fee_bps?: number;
  /** The fee, in minor units of `currency`, on top of a publisher price of `seller_minor`. A whole number, 0 or more. */
  feeFor(seller_minor: number, currency: string): number;
}

/** No fee. Used by tests that want no fee; composition never falls back to it (see UNREADABLE_FEE_POLICY). */
export const ZERO_FEE_POLICY: ImportFeePolicy = { fee_bps: 0, feeFor: () => 0 };

/** What the review uses when the fee setting cannot be read: it answers nothing, so no buyer price is shown (fail closed). */
export const UNREADABLE_FEE_POLICY: ImportFeePolicy = {
  feeFor() {
    throw new Error('the platform fee could not be read');
  },
};

/** The fee lane's policy (rate and parts) as the import's port: the same rate, the same rounding. */
export function importFeeFrom(policy: FeePolicy): ImportFeePolicy {
  return {
    fee_bps: policy.fee_bps,
    feeFor: (seller_minor, currency) => policy.feeFor(seller_minor, currency).fee_minor,
  };
}

/**
 * The policy in force for one call: the loader when the deps carry one (it reads the setting each time), else the fixed
 * policy of the deps. Null when the loader throws: the caller shows no buyer price, or refuses to publish.
 */
export async function resolveImportFee(d: {
  fee: ImportFeePolicy;
  loadFee?: () => Promise<ImportFeePolicy>;
}): Promise<ImportFeePolicy | null> {
  if (d.loadFee === undefined) return d.fee;
  try {
    return await d.loadFee();
  } catch {
    return null;
  }
}

/**
 * The fee and the buyer total for one seller price, or null when the price is not a whole positive number or
 * the policy throws or answers something that is not a whole number of 0 or more. The page then shows the
 * publisher price and no buyer price; it never shows a guess.
 */
export function buyerPriceOf(
  policy: ImportFeePolicy,
  seller_minor: number,
  currency: string,
): { fee_minor: number; buyer_minor: number } | null {
  if (!Number.isSafeInteger(seller_minor) || seller_minor < 1) return null;
  let fee: unknown;
  try {
    fee = policy.feeFor(seller_minor, currency);
  } catch {
    return null;
  }
  if (typeof fee !== 'number' || !Number.isSafeInteger(fee) || fee < 0) return null;
  const buyer = seller_minor + fee;
  if (!Number.isSafeInteger(buyer)) return null;
  return { fee_minor: fee, buyer_minor: buyer };
}
