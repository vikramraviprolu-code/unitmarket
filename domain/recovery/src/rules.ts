// Pure rules of the recovery case machine (architecture 4.5). No database and no clock: callers
// pass the time in. Owned by SBX lane 10.
import type { AccessEventKind, CaseKind, CaseState } from '@umsbx/contracts';

/** States that still need work. A resolved case frees the slot for a new one of the same kind. */
export const UNRESOLVED_STATES: readonly CaseState[] = ['open', 'diagnosing', 'refund_pending'];
/** States an operator or a rule may resolve from. refund_pending waits for the payments read-back. */
export const RESOLVABLE_STATES: readonly CaseState[] = ['open', 'diagnosing'];

/** Alert kinds (written by payments) that become cases. */
export const ALERT_CASE_KINDS = [
  'frozen_order',
  'payment_unresolved',
  'partial_composite',
  'reversal',
] as const;

/** Kinds a buyer may report. The rest come from system evidence or an operator. */
export const BUYER_KINDS: readonly CaseKind[] = [
  'delivery_failed',
  'payment_unresolved',
  'refund_requested',
];

const HOUR_MS = 3_600_000;
/** Time an operator has to look at a case, by kind. */
export const SLA_MS: Record<CaseKind, number> = {
  delivery_failed: 24 * HOUR_MS,
  payment_unresolved: 4 * HOUR_MS,
  frozen_order: 4 * HOUR_MS,
  partial_composite: 24 * HOUR_MS,
  refund_requested: 48 * HOUR_MS,
  reversal: 4 * HOUR_MS,
};

export function slaDueAt(kind: CaseKind, now: Date): string {
  return new Date(now.getTime() + SLA_MS[kind]).toISOString();
}

/** Unit statuses that carry a verified capture: money was taken, so "not charged" is untrue. */
export const VERIFIED_UNIT_STATUSES: readonly string[] = [
  'captured_verified',
  'partially_refunded',
  'refunded',
  'reversal_suspected',
  'reversed',
];

/** Access events that end a pause (the access clock credits the measured time). */
export const RESUME_KINDS: ReadonlySet<AccessEventKind> = new Set([
  'delivery_restored',
  'download_completed',
  'reader_rendered',
]);

export type ResolveAction =
  'restore' | 'credit' | 'close_not_charged' | 'offer_refund' | 'close_no_fault';

/** The state each resolve action ends in. */
export const ACTION_STATE: Record<ResolveAction, CaseState> = {
  restore: 'restored',
  credit: 'restored',
  close_not_charged: 'closed_not_charged',
  offer_refund: 'refund_pending',
  close_no_fault: 'closed_no_fault',
};

/** Where a case in refund_pending goes when its refund settles (refundCaseOutcome). */
export const REFUND_CASE_STATE: Record<'refunded' | 'diagnosing', CaseState> = {
  refunded: 'refunded',
  diagnosing: 'diagnosing',
};

/** Refund request states a case may rest on. `unresolved` is not settled: a human decides it. */
const REFUND_DONE = 'completed';
const REFUND_NOT_DONE: ReadonlySet<string> = new Set(['failed', 'cancelled', 'rejected']);

/** A case follows a handful of refund requests (one per unit); a longer list is not followed. */
export const MAX_FOLLOWED_REFUNDS = 20;

export type RefundCaseOutcome = 'refunded' | 'diagnosing' | 'wait';

/**
 * What a case in refund_pending does, from the states of the refund requests its offer made
 * (CO-4, architecture 4.5): every request completed moves it to `refunded`; once every request is
 * settled and any of them failed, was cancelled or was rejected, it goes back to `diagnosing`; while
 * any request is still open (requested, sent, unknown, pending) or unresolved, or there is nothing
 * to follow, it waits.
 */
export function refundCaseOutcome(states: readonly string[]): RefundCaseOutcome {
  if (states.length === 0) return 'wait';
  if (!states.every((s) => s === REFUND_DONE || REFUND_NOT_DONE.has(s))) return 'wait';
  return states.every((s) => s === REFUND_DONE) ? 'refunded' : 'diagnosing';
}
