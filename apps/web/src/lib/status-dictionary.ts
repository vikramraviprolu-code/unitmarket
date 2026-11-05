// INT-UI0 / UI0.5: one dictionary for every raw order, unit, refund and case state: a word, what it means,
// who acts next and how long it usually lasts. Pure. The key sets are the contracts' own lists, so a new
// state fails status-dictionary.golden.test.ts until it has words here. The six group words (paid, refunded
// and so on) are SR0's STATUS_GROUPS in contracts: they are not defined here, and screens that show groups
// import them from there.
// The "usual time" is a coarse band written from how the engine works, not a measured figure; the owner
// reviews the wording. Wording rules: D-051, one sentence per meaning, no italics, no dashes.
import type { CaseState, OrderStatus, RefundRequestState, UnitStatus } from '@umsbx/contracts';

export const STATUS_ACTORS = [
  'Buyer',
  'Seller',
  'UnitMarket',
  'PayPal',
  'Operator',
  'Nobody',
] as const;
export type StatusActor = (typeof STATUS_ACTORS)[number];

export interface StatusEntry {
  /** The short word a chip shows. */
  word: string;
  /** One sentence, plain words. */
  meaning: string;
  /** Who has to act for this to move on. */
  next: StatusActor;
  /** How long it usually lasts. */
  usual: string;
}

/** The meaning is written without its full stop; this adds it, so every entry is one sentence. */
const e = (word: string, meaning: string, next: StatusActor, usual: string): StatusEntry => ({
  word,
  meaning: `${meaning}.`,
  next,
  usual,
});

export type StatusFamily = 'order' | 'unit' | 'refund' | 'case';

export const STATUS_DICTIONARY: {
  order: Record<OrderStatus, StatusEntry>;
  unit: Record<UnitStatus, StatusEntry>;
  refund: Record<RefundRequestState, StatusEntry>;
  case: Record<CaseState, StatusEntry>;
} = {
  order: {
    created: e(
      'Started',
      'The order exists and the buyer has not been sent to pay yet',
      'Buyer',
      'Seconds',
    ),
    awaiting_buyer: e(
      'Awaiting buyer',
      'The buyer has been sent to PayPal and has not approved the payment yet',
      'Buyer',
      'Minutes',
    ),
    capture_requested: e(
      'Payment requested',
      'UnitMarket has asked PayPal to take the payment',
      'PayPal',
      'Seconds',
    ),
    capture_claimed: e(
      'Taking payment',
      'A worker has picked up the payment and is waiting for the answer from PayPal',
      'PayPal',
      'Seconds',
    ),
    unresolved: e(
      'Needs a check',
      'The answer from PayPal was unclear, so the payment is on hold until a person checks it',
      'Operator',
      'Until someone acts',
    ),
    paid: e('Paid', 'The payment was taken and checked', 'Nobody', 'Final'),
    paid_partial: e(
      'Partly paid',
      'Some items were paid and the others were not, and each item shows its own state',
      'Nobody',
      'Final',
    ),
    failed: e(
      'Failed',
      'The payment did not go through and nothing was charged',
      'Nobody',
      'Final',
    ),
    abandoned: e(
      'Abandoned',
      'The buyer left or cancelled before paying, so nothing was charged',
      'Nobody',
      'Final',
    ),
    frozen: e(
      'Frozen',
      'A safety stop is holding the order until a person checks it',
      'Operator',
      'Until someone acts',
    ),
  },
  unit: {
    expected: e('Expected', 'The item is waiting for its payment', 'Buyer', 'Minutes'),
    captured_verified: e(
      'Paid and checked',
      'The payment for this item was taken and matches the order',
      'Nobody',
      'Final',
    ),
    pending: e(
      'Payment pending',
      'PayPal has the payment for this item and has not finished it',
      'PayPal',
      'Hours or days',
    ),
    declined: e('Declined', 'PayPal declined the payment for this item', 'Nobody', 'Final'),
    mismatch: e(
      'Amount mismatch',
      'PayPal reports a different amount than the order, so the item is held',
      'Operator',
      'Until someone acts',
    ),
    partially_refunded: e(
      'Partly refunded',
      'Part of the price of this item has been given back',
      'Nobody',
      'Final',
    ),
    refunded: e('Refunded', 'The whole price of this item has been given back', 'Nobody', 'Final'),
    reversal_suspected: e(
      'Reversal suspected',
      'PayPal may have taken the payment back and a person needs to confirm it',
      'Operator',
      'Until someone acts',
    ),
    reversed: e('Reversed', 'PayPal took the payment for this item back', 'Nobody', 'Final'),
  },
  refund: {
    requested: e(
      'Requested',
      'A refund was entered and has not been sent to PayPal yet',
      'UnitMarket',
      'Seconds',
    ),
    sent: e(
      'Sent',
      'The refund was sent to PayPal and PayPal has not answered yet',
      'PayPal',
      'Seconds',
    ),
    unknown: e(
      'Not sure yet',
      'The refund may or may not have reached PayPal, so UnitMarket is checking',
      'UnitMarket',
      'Minutes',
    ),
    pending: e(
      'Pending',
      'PayPal accepted the refund and has not finished it',
      'PayPal',
      'Minutes or hours',
    ),
    unresolved: e(
      'Needs a decision',
      'Nobody could prove whether PayPal refunded, so the amount stays reserved until a person decides',
      'Operator',
      'Until someone acts',
    ),
    completed: e('Refunded', 'PayPal finished the refund and the books show it', 'Nobody', 'Final'),
    failed: e('Failed', 'The refund did not happen and nothing was returned', 'Nobody', 'Final'),
    cancelled: e('Cancelled', 'The refund was cancelled before it finished', 'Nobody', 'Final'),
    rejected: e(
      'Refused by PayPal',
      'PayPal refused the refund request, so a person decides what to do',
      'Operator',
      'No usual time',
    ),
  },
  case: {
    open: e(
      'Open',
      'A problem was found and nobody has looked into it yet',
      'UnitMarket',
      'Minutes',
    ),
    diagnosing: e(
      'Being checked',
      'UnitMarket is working out what went wrong',
      'UnitMarket',
      'Minutes',
    ),
    restored: e(
      'Restored',
      'The buyer got access back or a credit, and the case is settled',
      'Nobody',
      'Final',
    ),
    closed_not_charged: e(
      'Closed, not charged',
      'The buyer was not charged, so the case was closed',
      'Nobody',
      'Final',
    ),
    refund_pending: e(
      'Refund pending',
      'A refund was offered and has not finished yet',
      'UnitMarket',
      'Minutes or hours',
    ),
    refunded: e('Refunded', 'The refund finished and the case is settled', 'Nobody', 'Final'),
    closed_no_fault: e(
      'Closed, no fault',
      'Nothing went wrong on our side, so the case was closed',
      'Nobody',
      'Final',
    ),
    closed: e('Closed', 'The case is closed and has no further step', 'Nobody', 'Final'),
  },
};

/** The entry for a raw state, or null when the dictionary does not know it (the caller shows the raw word). */
export function statusEntry(family: StatusFamily, raw: string): StatusEntry | null {
  const table: Record<string, StatusEntry> = STATUS_DICTIONARY[family];
  return Object.hasOwn(table, raw) ? (table[raw] ?? null) : null;
}
