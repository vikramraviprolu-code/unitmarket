// CO-8 unit: the pure parts of the refund logic (apps/web/src/server/refund.ts). What the buyer is told
// comes only from stored facts (money state, unit status, window state, access option); nothing is
// computed in a page. Amounts and codes of the refusals are checked in refund.state.test.ts.
import { describe, expect, it } from 'vitest';
import type { Actor, Database, Logger, Result } from '@umsbx/contracts';
import { err, ok } from '@umsbx/contracts';
import {
  buyerRefundNote,
  buyerStatusText,
  createRefundFacade,
  isFullyRefunded,
  QUEUED_MESSAGE,
  REFUSALS,
  UNKNOWN_MESSAGE,
  answerFor,
  cancelRefusal,
} from './refund';
import type { RefundWiring } from './refund';

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

describe('isFullyRefunded', () => {
  it('a full refund, not a partial one and not a reversal', () => {
    expect(isFullyRefunded({ money: 'refunded', unit_status: 'refunded' })).toBe(true);
    expect(isFullyRefunded({ money: 'captured', unit_status: 'refunded' })).toBe(true);
    expect(isFullyRefunded({ money: 'captured', unit_status: 'partially_refunded' })).toBe(false);
    expect(isFullyRefunded({ money: 'reversed', unit_status: 'reversed' })).toBe(false);
    expect(isFullyRefunded({ money: 'captured', unit_status: 'captured_verified' })).toBe(false);
  });
});

// The facade with the payments functions and the database faked, to reach the answers a dry run
// cannot make: a refund call whose answer was lost, and refunds paused between request and send.
const OPERATOR: Actor = { kind: 'operator', operator_id: 'opr_test', mfa: true };
function fake(o: {
  request_state: string | null;
  execute: Result<{ status: 'COMPLETED' | 'PENDING' | 'FAILED' | 'CANCELLED' }, { code: string }>;
  actor?: Actor;
}) {
  const audits: Record<string, unknown>[] = [];
  const calls = { request: 0, execute: 0 };
  const query = async (sql: string): Promise<{ rows: Record<string, unknown>[] }> => {
    if (sql.includes('SELECT o.currency')) return { rows: [{ currency: 'USD' }] };
    if (sql.includes('SELECT state FROM refund_requests'))
      return { rows: o.request_state === null ? [] : [{ state: o.request_state }] };
    if (sql.includes('FROM refund_requests r JOIN order_units u'))
      return {
        rows: [
          {
            unit_id: 'unt_1',
            amount_minor: 100,
            currency: 'USD',
            total: 450,
            refunded_minor: 0,
            status: 'captured_verified',
          },
        ],
      };
    return { rows: [] };
  };
  const db = {
    dialect: 'pglite',
    query,
    exec: async () => undefined,
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ query }),
  } as unknown as Database;
  const log: Logger = { log: () => undefined, child: () => log };
  const wiring: RefundWiring = {
    db,
    log,
    audit: {
      record: async (_tx, e) => {
        audits.push({ ...e.detail, reason: e.reason });
      },
    },
    requestRefund: async () => {
      calls.request += 1;
      return ok({ refund_request_id: 'rfr_1' });
    },
    executeRefund: async () => {
      calls.execute += 1;
      return o.execute;
    },
    cancelRefund: async () => ok({ refund_request_id: 'rfr_1' }),
  };
  return { facade: createRefundFacade(wiring), audits, calls, actor: o.actor ?? OPERATOR };
}
const input = (actor: Actor) => ({
  actor,
  unit_id: 'unt_1',
  amount_minor: 100,
  reason: 'a reason',
});

describe('the facade when the answer is not a clean yes', () => {
  it('CO-8b M2: a refund that was never sent (still requested) says nothing was sent and it will go later', async () => {
    const f = fake({ request_state: 'requested', execute: err({ code: 'unknown' }) });
    const r = await f.facade.request(input(f.actor));
    expect(r.ok && r.value.state).toBe('unknown');
    expect(r.ok && r.value.message).toBe(QUEUED_MESSAGE);
    expect(QUEUED_MESSAGE).toBe(
      'Nothing was sent yet: PayPal could not be read. The system will send this refund when PayPal can be read again, for up to 24 hours. Withdraw it on this page if it should not go.',
    );
  });
  it('a refund that was sent and whose answer was lost keeps the "could not confirm" words', async () => {
    for (const state of ['sent', 'unknown', 'pending', 'unresolved']) {
      const f = fake({ request_state: state, execute: err({ code: 'unknown' }) });
      const r = await f.facade.request(input(f.actor));
      expect(r.ok && r.value.message, state).toBe(UNKNOWN_MESSAGE);
    }
  });
  it('CO-8b L1: refunds paused between request and send has its own words and the request stays open', async () => {
    const f = fake({ request_state: 'requested', execute: err({ code: 'rejected' }) });
    const r = await f.facade.request(input(f.actor));
    expect(r).toEqual(err({ code: 'refunds_paused_midway' }));
    expect(answerFor(r)).toMatchObject({
      status: 503,
      code: 'refunds_paused_midway',
      message:
        'Refunds were paused before it was sent. Nothing was refunded. Withdraw the open request on this page, then try again when refunds are on.',
    });
  });
  it('PayPal saying no is refund_rejected', async () => {
    const f = fake({ request_state: 'rejected', execute: err({ code: 'rejected' }) });
    expect(await f.facade.request(input(f.actor))).toEqual(err({ code: 'refund_rejected' }));
  });
  it('every attempt is audited with its outcome, and a second-factor-less actor is stopped before payments', async () => {
    const a = fake({ request_state: 'requested', execute: err({ code: 'unknown' }) });
    await a.facade.request(input(a.actor));
    expect(a.audits.map((x) => x['outcome'])).toEqual(['unknown']);
    const b = fake({
      request_state: null,
      execute: ok({ status: 'COMPLETED' }),
      actor: { kind: 'operator', operator_id: 'opr_demo', mfa: false },
    });
    expect(await b.facade.request(input(b.actor))).toEqual(err({ code: 'mfa_required' }));
    expect(b.calls).toEqual({ request: 0, execute: 0 });
    expect(b.audits.map((x) => x['outcome'])).toEqual(['mfa_required']);
  });
});
