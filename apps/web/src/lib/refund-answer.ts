// What the refund form tells the operator (CO-8b M1, L3). Pure: no network, no clock.
//
// A refusal the route made on purpose, before or instead of moving money, says "Nothing was refunded"
// and carries its own words. Any other failure (no network, a 500, a 409 in_progress while the first
// request still runs) proves nothing either way: the refund may have been made. The form must then say
// so, and must not suggest starting a new one.

/** The answer for a failure that is not a clear refusal. */
export const UNKNOWN_FAILURE_MESSAGE =
  'We do not know yet whether this refund was made. Do not start a new refund. Reload the page and check the open requests for this payment.';

// Codes the route and its wrapper return when no refund was made: the facade's refusals (403, 409, 503)
// and the wrapper's own refusals, which all come before the handler runs.
const REFUSED_BEFORE_MONEY = new Set([
  'mfa_required',
  'not_captured',
  'over_refund',
  'refund_in_flight',
  'unit_frozen',
  'refund_failed',
  'refund_rejected',
  'refunds_paused',
  'refunds_paused_midway',
  'unauthenticated',
  'forbidden',
  'csrf',
  'invalid_input',
  'idempotency_key',
  'idempotency_key_reused',
  'rate_limited',
]);

export function refundFailureView(f: { status: number; code: string; message: string }): {
  title: string;
  message: string;
} {
  if (REFUSED_BEFORE_MONEY.has(f.code)) {
    return {
      title: 'Nothing was refunded',
      message: f.status === 401 ? 'Please sign in again with your authenticator code.' : f.message,
    };
  }
  return { title: 'Refund not confirmed', message: UNKNOWN_FAILURE_MESSAGE };
}

/** What to say about an open request the operator cannot withdraw. */
export function openRequestWaitText(state: string): string {
  return state === 'unresolved' ? 'A person must look at this request.' : 'Wait for it to finish.';
}
