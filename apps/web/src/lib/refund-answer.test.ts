// CO-8b M1, L3: what the refund form tells the operator when an answer is not a clear refusal, and what
// it says about a request that is open. Pure: no network, no clock.
import { describe, expect, it } from 'vitest';
import { openRequestWaitText, refundFailureView, UNKNOWN_FAILURE_MESSAGE } from './refund-answer';

const f = (status: number, code: string, message = 'Plain words.') => ({ status, code, message });

describe('refundFailureView', () => {
  it('a known refusal keeps its own words under the title "Nothing was refunded"', () => {
    for (const [status, code] of [
      [403, 'mfa_required'],
      [409, 'not_captured'],
      [409, 'over_refund'],
      [409, 'refund_in_flight'],
      [409, 'unit_frozen'],
      [409, 'refund_failed'],
      [409, 'refund_rejected'],
      [503, 'refunds_paused'],
      [503, 'refunds_paused_midway'],
    ] as const) {
      expect(refundFailureView(f(status, code, 'Their words.')), code).toEqual({
        title: 'Nothing was refunded',
        message: 'Their words.',
      });
    }
  });
  it('a refusal made before any handler ran is also a clear "nothing was refunded"', () => {
    for (const [status, code] of [
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [403, 'csrf'],
      [422, 'invalid_input'],
      [422, 'idempotency_key'],
      [422, 'idempotency_key_reused'],
      [429, 'rate_limited'],
    ] as const)
      expect(refundFailureView(f(status, code)).title, code).toBe('Nothing was refunded');
  });
  it('a session that ended says to sign in again', () => {
    expect(refundFailureView(f(401, 'unauthenticated')).message).toMatch(/sign in again/i);
  });
  it('anything else does not claim that nothing was refunded', () => {
    for (const x of [
      f(0, 'network', 'We could not reach the server.'),
      f(500, 'internal', 'Something went wrong. (reference abc)'),
      f(409, 'in_progress', 'The first request is still running.'),
      f(502, 'error'),
      f(409, 'something_new'),
    ]) {
      const v = refundFailureView(x);
      expect(v.title).toBe('Refund not confirmed');
      expect(v.message).toBe(UNKNOWN_FAILURE_MESSAGE);
      expect(JSON.stringify(v)).not.toMatch(/nothing was refunded/i);
    }
  });
  it('the unknown message is the reviewed text', () => {
    expect(UNKNOWN_FAILURE_MESSAGE).toBe(
      'We do not know yet whether this refund was made. Do not start a new refund. Reload the page and check the open requests for this payment.',
    );
  });
});

describe('openRequestWaitText', () => {
  it('unresolved needs a person; the other open states wait', () => {
    expect(openRequestWaitText('unresolved')).toBe('A person must look at this request.');
    for (const s of ['sent', 'unknown', 'pending'])
      expect(openRequestWaitText(s)).toBe('Wait for it to finish.');
  });
});
