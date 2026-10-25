// CO-8b M1, L3: what the refund form tells the operator when an answer is not a clear refusal, and what
// it says about a request that is open. Pure: no network, no clock.
import { describe, expect, it } from 'vitest';
import {
  answerTone,
  openRequestWaitText,
  refreshAfterFailure,
  refundFailureView,
  UNKNOWN_FAILURE_MESSAGE,
  unitLine,
} from './refund-answer';

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

// CO-8c L1: two cards can share a title, so the result line names the order too.
describe('unitLine', () => {
  it('titles then the order reference', () => {
    expect(unitLine(['A notebook of six working knots'], 'UM-1042')).toBe(
      'A notebook of six working knots (order UM-1042)',
    );
    expect(unitLine(['Tide tables', 'Harbour fees'], 'UM-7')).toBe(
      'Tide tables, Harbour fees (order UM-7)',
    );
  });
  it('two units with the same title give two different lines', () => {
    const t = ['A notebook of six working knots'];
    expect(unitLine(t, 'UM-1')).not.toBe(unitLine(t, 'UM-2'));
  });
  it('no titles: the order alone, once', () => {
    expect(unitLine([], 'UM-9')).toBe('order UM-9');
  });
  it('plain copy: no dashes', () => {
    expect(unitLine(['Tide tables'], 'UM-1')).not.toMatch(/[\u2013\u2014]| - /);
  });
});

// CO-8c L2: refresh only when the page is known to be stale. An unknown outcome must NOT reload the
// page data: a refresh brings a new Idempotency-Key and drops the replay protection.
describe('refreshAfterFailure', () => {
  it('refunds_paused_midway refreshes: the open request and the paused banner are new', () => {
    expect(refreshAfterFailure('refunds_paused_midway')).toBe(true);
  });
  it('an unknown outcome never refreshes', () => {
    for (const code of ['network', 'internal', 'in_progress', 'error', 'something_new', ''])
      expect(refreshAfterFailure(code), code).toBe(false);
  });
  it('no other refusal refreshes', () => {
    for (const code of [
      'mfa_required',
      'not_captured',
      'over_refund',
      'refund_in_flight',
      'unit_frozen',
      'refund_failed',
      'refund_rejected',
      'refunds_paused',
      'unauthenticated',
      'forbidden',
      'csrf',
      'invalid_input',
      'idempotency_key',
      'idempotency_key_reused',
      'rate_limited',
    ])
      expect(refreshAfterFailure(code), code).toBe(false);
  });
});

// CO-8c nit: green only for a booked refund; the label is text, so colour is never the only signal.
describe('answerTone', () => {
  it('completed is success with no extra label', () => {
    expect(answerTone('completed')).toEqual({ tone: 'success', label: null });
  });
  it('queued, unknown and pending answers are a warning with a text label', () => {
    for (const s of ['unknown', 'pending', 'queued', undefined, 'something_new'])
      expect(answerTone(s), String(s)).toEqual({ tone: 'warn', label: 'Not finished yet' });
  });
});
