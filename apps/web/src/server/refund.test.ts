// CO-8 unit: the pure parts of the refund logic (apps/web/src/server/refund.ts). What the buyer is told
// comes only from stored facts (money state, unit status, window state, access option); nothing is
// computed in a page. Amounts and codes of the refusals are checked in refund.state.test.ts.
import { describe, expect, it } from 'vitest';
import { buyerRefundNote, buyerStatusText, REFUSALS, answerFor, cancelRefusal } from './refund';

const base = 'Ready, 4 days 23 hours left';
const t = (o: Partial<Parameters<typeof buyerStatusText>[0]>) =>
  buyerStatusText({
    base,
    money: 'captured',
    window_state: 'running',
    option: 'online_read',
    unit_status: 'captured_verified',
    ...o,
  });

describe('buyerStatusText', () => {
  it('leaves an untouched purchase alone', () => {
    expect(t({})).toBe(base);
  });
  it('a full refund: online says access has ended, keep says links have stopped and no recall', () => {
    expect(t({ money: 'refunded', unit_status: 'refunded', window_state: 'revoked' })).toBe(
      'Refunded: access has ended',
    );
    expect(
      t({
        money: 'refunded',
        unit_status: 'refunded',
        window_state: 'revoked',
        option: 'keep_retrieve',
      }),
    ).toBe('Refunded: links have stopped. The copy you downloaded cannot be recalled.');
  });
  it('the unit status alone is enough (the entitlement may be written a moment later)', () => {
    expect(t({ unit_status: 'refunded' })).toBe('Refunded: access has ended');
  });
  it('a partial refund keeps access whatever the option, and shows no per-item state', () => {
    for (const option of ['online_read', 'keep_retrieve'])
      for (const window_state of ['running', 'paused', 'not_started'])
        expect(t({ unit_status: 'partially_refunded', option, window_state })).toBe(
          'Partially refunded: your access continues',
        );
  });
  it('a partial refund after the window ended keeps the ended wording', () => {
    expect(
      t({ unit_status: 'partially_refunded', window_state: 'ended', base: 'Reading ended' }),
    ).toBe('Partially refunded. Reading ended');
  });
  it('a reversal is not a refund', () => {
    expect(
      t({
        money: 'reversed',
        unit_status: 'reversed',
        base: 'Payment reversed',
        window_state: 'revoked',
      }),
    ).toBe('Payment reversed');
  });
  it('pending and confirming are passed through', () => {
    expect(
      t({
        money: 'pending',
        unit_status: 'pending',
        base: 'Payment pending at PayPal',
        window_state: 'not_started',
      }),
    ).toBe('Payment pending at PayPal');
    expect(
      t({
        money: 'unknown',
        unit_status: 'expected',
        base: 'Confirming payment',
        window_state: 'not_started',
      }),
    ).toBe('Confirming payment');
  });
});

describe('buyerRefundNote', () => {
  it('only a partial refund has a note, and it says access to every item continues', () => {
    expect(buyerRefundNote({ money: 'captured', unit_status: 'partially_refunded' })).toMatch(
      /every item in the order continues/,
    );
    expect(buyerRefundNote({ money: 'captured', unit_status: 'captured_verified' })).toBeNull();
    expect(buyerRefundNote({ money: 'refunded', unit_status: 'refunded' })).toBeNull();
  });
});

describe('answers', () => {
  it('every refusal is a 4xx or 503 with a plain message that says nothing was refunded where true', () => {
    for (const [k, r] of Object.entries(REFUSALS)) {
      expect([403, 409, 503], k).toContain(r.http);
      expect(r.message.length, k).toBeGreaterThan(20);
      expect(r.message, k).not.toMatch(/undefined|\[object|Error:/);
    }
    expect(REFUSALS.refunds_off.message).toContain('Refunds paused');
  });
  it('answerFor turns an error into the HTTP result and a done refund into 200 (202 when unknown)', () => {
    expect(answerFor({ ok: false, error: { code: 'over_refund' } })).toMatchObject({
      status: 409,
      code: 'over_refund',
    });
    expect(answerFor({ ok: false, error: { code: 'not_operator' } })).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    const done = {
      refund_request_id: 'rfr_1',
      unit_id: 'oru_1',
      state: 'completed',
      amount_minor: 1,
      currency: 'USD',
      refunded_minor: 1,
      remaining_minor: 0,
      unit_status: 'refunded',
      message: 'm',
    } as const;
    expect(answerFor({ ok: true, value: done })).toMatchObject({ status: 200 });
    expect(answerFor({ ok: true, value: { ...done, state: 'unknown' } })).toMatchObject({
      status: 202,
    });
  });
  it('cancel refusals', () => {
    expect(cancelRefusal('wrong_state').http).toBe(409);
    expect(cancelRefusal('not_found').http).toBe(404);
    expect(cancelRefusal('mfa_required').http).toBe(403);
  });
});
