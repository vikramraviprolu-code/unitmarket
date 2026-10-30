// ORDER-A (docs/specs/order-a-cancel-resume.md): what the order page offers. Pure, from the order view's
// status alone, so a test can list every status. Only an order that waits for its buyer offers anything.
// The order view is null for anyone but the owner (A-20), so the viewer here is always the owner.

export interface OrderActionsView {
  status: string;
}

export function orderActions(v: OrderActionsView): { resume: boolean; cancel: boolean } {
  const waiting = v.status === 'awaiting_buyer';
  return { resume: waiting, cancel: waiting };
}

export const RESUME_BUTTON = 'Continue to payment';
export const CANCEL_BUTTON = 'Cancel order';
export const RESUME_BUSY = 'Opening payment';
export const CANCEL_BUSY = 'Cancelling';
export const CANCEL_DONE = 'Order cancelled. Nothing was charged.';

/** What the buyer is told when a cancel is refused or cannot be done, by the route's error code. */
export const CANCEL_ANSWER = {
  wrong_state: 'This order can no longer be cancelled. Its status is shown above.',
  payment_started:
    'You have already started paying for this order, so it cannot be cancelled here. Check this page again in a minute to see where it stands.',
  unavailable:
    'We could not check this order with PayPal just now. Nothing was changed. Please try again in a moment.',
} as const;

export type CancelAnswerKey = keyof typeof CANCEL_ANSWER;
