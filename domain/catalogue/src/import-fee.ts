// POB-I1 (D-089, review finding): the fee the buyer pays on top of the publisher's price, as a PORT of the
// web import. The import defines its own interface and imports no code of the fee lane (POB-M1); after that
// lane merges, composition wires the real policy into AppOptions.import_fee. Until then the fee is zero.
//
// The fee shown at review is information only: it is never stored on an item and never written to an offer.
// The price a buyer is charged is decided later, at the quote, by the fee lane.

export interface ImportFeePolicy {
  /** The fee, in minor units of `currency`, on top of a publisher price of `seller_minor`. A whole number, 0 or more. */
  feeFor(seller_minor: number, currency: string): number;
}

/** The default until the fee lane lands: no fee. */
export const ZERO_FEE_POLICY: ImportFeePolicy = { feeFor: () => 0 };

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
