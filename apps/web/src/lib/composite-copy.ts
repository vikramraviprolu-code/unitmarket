// The words a buyer is shown for a pack (MVP-D, DP-5). Pure: no server module, no clock. Pages, the
// approvals route and the engine facade take their sentences from here, and the golden test pins
// them. Wording rules: D-051 (the verb follows the number of titles; "not charged" only for a
// declined, failed or abandoned PayPal order, never for a held one) and OQ-5 (the step page).

/** Whole minutes of the pack approval window, rounded down. Never typed in a page. */
export const windowMinutes = (ms: number): number => Math.floor(ms / 60_000);

export const packNotice = (payments: number): string =>
  `You will approve ${String(payments)} payments at PayPal, one for each publisher. You are charged only after you have approved ${payments === 2 ? 'both' : 'all'}.`;

export const BUY_SELECTED = 'Buy selected together';
export const MIXED_CURRENCY_TEXT =
  'These items are priced in different currencies, so they cannot be bought together. Choose items in one currency.';
export const TOO_MANY_PUBLISHERS_TEXT =
  'A pack can include items from two publishers at most. Choose items from fewer publishers.';

export const stepHeading = (step: number, of: number, publisher: string): string =>
  `Step ${String(step)} of ${String(of)}: approve your payment to ${publisher} at PayPal`;
export const stepButton = (step: number, of: number): string =>
  `Approve payment ${String(step)} of ${String(of)} at PayPal`;
export const stepDeadline = (minutes: number): string =>
  `If you do not approve within ${String(minutes)} minutes, the whole order may be cancelled and nothing is charged.`;

export const CANCEL_HEADING = 'You did not approve this payment';
// "Nothing was charged" is said of the payment the buyer cancelled only (D-051): the page cannot know
// the state of the rest of the order. It names no window length: it is a static page, and the length
// is configured (pack_approval_window_ms), so it is not typed here.
export const CANCEL_BODY =
  'You did not approve this payment at PayPal. Nothing was charged for this payment. If you approved another payment of this order, it will not be taken unless you approve the rest.';
export const CANCEL_WINDOW_LINE =
  'If the order window is still open, you can still approve the other payment from the order page.';

/** What one item of a pack says, from stored facts only. */
export type LineKind =
  | 'ready'
  | 'paid_locked'
  | 'refunded'
  | 'partly_refunded'
  | 'declined'
  | 'abandoned'
  | 'hold'
  | 'awaiting'
  | 'approved'
  | 'confirming'
  | 'pending';

export const LINE_TEXT: Record<LineKind, string> = {
  ready: 'Ready in your library',
  paid_locked: 'Paid. Not unlocked yet',
  refunded: 'Refunded',
  partly_refunded: 'Partly refunded',
  declined: 'Not charged: PayPal declined this payment',
  abandoned: 'Not charged: this payment was not completed',
  hold: 'On hold while we check it',
  awaiting: 'Waiting for your approval at PayPal',
  approved: 'Approved at PayPal. Waiting for the other payment',
  confirming: 'Confirming payment',
  pending: 'Payment pending at PayPal',
};

/** The PayPal order states in which nothing was taken and the buyer was told so (D-051). */
const NOT_CHARGED_STATES: ReadonlySet<string> = new Set(['declined', 'failed']);

/**
 * One item's line from the payment outcome (the receipts word for it) and the stored states. A hold
 * always wins: a frozen PayPal order or a unit on hold is `hold` whether or not a capture was sent,
 * so a held item is never "Ready", "Paid" or "Confirming payment".
 */
export function lineKind(f: {
  outcome: 'paid' | 'refunded' | 'partially_refunded' | 'not_charged' | 'on_hold' | 'waiting';
  access: string;
  po_state: string | null;
  unit_status: string;
}): LineKind {
  switch (f.outcome) {
    case 'on_hold':
      return 'hold';
    case 'paid':
      return f.access === 'available' ? 'ready' : 'paid_locked';
    case 'refunded':
      return 'refunded';
    case 'partially_refunded':
      return 'partly_refunded';
    case 'not_charged':
      return f.po_state !== null && NOT_CHARGED_STATES.has(f.po_state) ? 'declined' : 'abandoned';
    case 'waiting': {
      if (f.unit_status === 'pending') return 'pending';
      if (f.po_state === 'approved') return 'approved';
      if (
        f.po_state === 'capture_requested' ||
        f.po_state === 'capture_claimed' ||
        f.po_state === 'unresolved'
      )
        return 'confirming';
      return 'awaiting';
    }
  }
}

const join = (titles: string[]): string => {
  const t = [...titles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return t.length <= 1 ? (t[0] ?? '') : `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]!}`;
};
const be = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * The order banner of a pack, from its item lines. The verb agrees with the number of titles. Null
 * while any item is still waiting and none is on hold: the generic words for the order status apply.
 */
export function packBanner(lines: { title: string; kind: LineKind }[]): string | null {
  const of = (...kinds: LineKind[]): string[] =>
    lines.filter((l) => kinds.includes(l.kind)).map((l) => l.title);
  const ready = of('ready');
  const hold = of('hold');
  const notCharged = of('declined', 'abandoned');
  const refunded = of('refunded', 'partly_refunded');
  const open = of('awaiting', 'approved', 'confirming', 'pending', 'paid_locked');
  if (open.length > 0 && hold.length === 0) return null;
  const out: string[] = [];
  if (ready.length > 0)
    out.push(`${join(ready)} ${be(ready.length, 'is', 'are')} ready in your library.`);
  if (hold.length > 0)
    out.push(
      `${join(hold)} ${be(hold.length, 'is', 'are')} on hold while we check ${be(hold.length, 'it', 'them')}.`,
    );
  if (notCharged.length > 0)
    out.push(`${join(notCharged)} ${be(notCharged.length, 'was', 'were')} not charged.`);
  if (refunded.length > 0)
    out.push(`${join(refunded)} ${be(refunded.length, 'is', 'are')} refunded.`);
  return out.length === 0 ? null : out.join(' ');
}
