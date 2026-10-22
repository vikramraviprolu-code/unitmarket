// What the buyer reads: one plain status per problem, no internals, no jargon. Owned by SBX lane 10.
import type { CaseKind } from '@umsbx/contracts';

const HOUR_MS = 3_600_000;

/** "6 hours", "1 hour", or minutes when the time is not a whole number of hours. */
export function spanText(ms: number): string {
  if (ms >= HOUR_MS && ms % HOUR_MS === 0) {
    const h = ms / HOUR_MS;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} minute${m === 1 ? '' : 's'}`;
}

export function openedMessage(kind: CaseKind, opened_by: 'system' | 'buyer' | 'operator'): string {
  if (opened_by === 'buyer') {
    return 'We got your report and are looking into it. You do not need to do anything else.';
  }
  switch (kind) {
    case 'delivery_failed':
      return 'We could not deliver your copy. Your access time is paused while we fix it. You do not need to do anything.';
    case 'payment_unresolved':
      return 'We are confirming your payment with PayPal. You will not be charged twice.';
    case 'frozen_order':
      return 'Your order is on hold while we check it. You have not been charged twice. We will write to you.';
    case 'partial_composite':
      return 'Part of your order did not complete. We are checking it and will write to you.';
    case 'refund_requested':
      return 'We got your refund request. Someone on our team will look at it.';
    case 'reversal':
      return 'PayPal reversed a payment. We are checking your access and will write to you.';
  }
}

export function restoredMessage(credit_ms: number): string {
  if (credit_ms <= 0) return 'We restored your access. No time was lost.';
  const t = spanText(credit_ms);
  return `We could not deliver your copy for ${t}. We added ${t} to your access.`;
}

export function creditMessage(credit_ms: number): string {
  return `We added ${spanText(credit_ms)} to your access. Sorry for the trouble.`;
}

export const NOT_CHARGED_MESSAGE = 'You were not charged. Nothing more is needed.';
export const REFUND_PENDING_MESSAGE =
  'We offered you a refund. It shows on your receipt once PayPal confirms it.';

/** The operator's reason is shown to the buyer, so it is trimmed and capped. */
export function noFaultMessage(reason: string): string {
  const clean = reason.replace(/\s+/g, ' ').trim().slice(0, 300);
  return `We checked and found no fault. ${clean}`;
}
