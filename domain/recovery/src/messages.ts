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

/**
 * The titles of the items of a case's own order, by what happened to their PayPal order (DP-3, OQ-8).
 * `ready`: money taken and verified. `held`: the PayPal order is frozen, on hold, money may have moved.
 * `not_charged`: the PayPal order was declined, failed or abandoned. A held item is never "not charged".
 */
export interface OrderTitles {
  ready: readonly string[];
  held: readonly string[];
  not_charged: readonly string[];
}

const TITLE_MAX = 80;
/** One clean line: whitespace collapsed, at most 80 characters. Titles are the publisher's text. */
export function cleanTitle(title: string): string {
  const one = title.replace(/\s+/g, ' ').trim();
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX).trimEnd()}...` : one;
}

/** "A", "A and B", "A, B and C". */
function titleList(titles: readonly string[]): string {
  const t = titles.map(cleanTitle);
  if (t.length <= 1) return t.join('');
  return `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`;
}
const be = (titles: readonly string[]): 'is' | 'are' => (titles.length === 1 ? 'is' : 'are');

/**
 * Part of a pack did not go through (OQ-8). Only when something is ready and something was not
 * charged; otherwise undefined and the caller keeps the plain text.
 */
export function partialMessage(t: OrderTitles): string | undefined {
  if (t.ready.length === 0 || t.not_charged.length === 0) return undefined;
  return `Part of your order did not go through. ${titleList(t.ready)} ${be(t.ready)} ready in your library. You were not charged for ${titleList(t.not_charged)}. If you would rather have a refund for what you paid, tell us on the help page.`;
}

/** A pack with a held PayPal order and ready items (L-6). Otherwise undefined: the whole-order text. */
export function holdMessage(t: OrderTitles): string | undefined {
  if (t.ready.length === 0 || t.held.length === 0) return undefined;
  return `${titleList(t.held)} ${be(t.held)} on hold while we check it. ${titleList(t.ready)} ${be(t.ready)} ready in your library.`;
}

export function openedMessage(
  kind: CaseKind,
  opened_by: 'system' | 'buyer' | 'operator',
  titles?: OrderTitles,
): string {
  if (opened_by === 'buyer') {
    return 'We got your report and are looking into it. You do not need to do anything else.';
  }
  switch (kind) {
    case 'delivery_failed':
      return 'We could not deliver your copy. Your access time is paused while we fix it. You do not need to do anything.';
    case 'payment_unresolved':
      return 'We are confirming your payment with PayPal. You will not be charged twice.';
    case 'frozen_order':
      return (
        (titles === undefined ? undefined : holdMessage(titles)) ??
        'Your order is on hold while we check it. You have not been charged twice. We will write to you.'
      );
    case 'partial_composite':
      return (
        (titles === undefined ? undefined : partialMessage(titles)) ??
        'Part of your order did not complete. We are checking it and will write to you.'
      );
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

export const REFUNDED_MESSAGE = 'Your refund went through. It shows on your receipt.';
export const REFUND_FAILED_MESSAGE =
  'The refund did not go through. We are looking into it and will write to you.';

/** The operator's reason is shown to the buyer, so it is trimmed and capped. */
export function noFaultMessage(reason: string): string {
  const clean = reason.replace(/\s+/g, ' ').trim().slice(0, 300);
  return `We checked and found no fault. ${clean}`;
}
