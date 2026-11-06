// BR-4 unit: the operator refund facade passes the override reason to the payments call, says a closed
// window in reader-safe words (409, "Nothing was refunded", no day count), and the form treats it as a
// clear refusal. Pure: a stubbed wiring, no database.
import { describe, expect, it, vi } from 'vitest';
import type { Actor, Database, Logger, Result } from '@umsbx/contracts';
import { err, ok } from '@umsbx/contracts';
import { REFUSALS, answerFor, createRefundFacade } from './refund';
import type { RefundWiring } from './refund';
import { refundFailureView } from '../lib/refund-answer';

const OP: Actor = { kind: 'operator', operator_id: 'opr_1', mfa: true };
const UNIT = 'unt_1';

function world(requestRefund: RefundWiring['requestRefund']) {
  const audits: { action: string; reason: string | null; detail: unknown }[] = [];
  const db = {
    transaction: (fn: (tx: unknown) => unknown) => Promise.resolve(fn({})),
    query: () => Promise.resolve({ rows: [{ currency: 'USD' }] }),
  } as unknown as Database;
  const log = { log: () => undefined, child: () => log } as unknown as Logger;
  const wiring: RefundWiring = {
    db,
    audit: {
      record: (_tx, e) => {
        audits.push({ action: e.action, reason: e.reason, detail: e.detail });
        return Promise.resolve();
      },
    },
    log,
    requestRefund,
    executeRefund: () => Promise.resolve(ok({ status: 'COMPLETED' as const })),
    cancelRefund: () => Promise.resolve(ok({ refund_request_id: 'rfr_1' })),
  };
  return { facade: createRefundFacade(wiring), audits };
}

describe('the refusal words', () => {
  it('refund_window_closed is a 409 that says nothing was refunded and how to override', () => {
    const r = REFUSALS['refund_window_closed'];
    expect(r.http).toBe(409);
    expect(r.code).toBe('refund_window_closed');
    expect(r.message).toMatch(/Nothing was refunded/);
    expect(r.message).toMatch(/reason/i);
    // D-051: no day count in the words.
    expect(r.message).not.toMatch(/\b\d+\s*days?\b/i);
  });
  it('answerFor maps it to HTTP 409', () => {
    const a = answerFor(err({ code: 'refund_window_closed' as const }));
    expect(a).toMatchObject({ status: 409, code: 'refund_window_closed' });
  });
  it('the form shows it as a clear refusal, under "Nothing was refunded"', () => {
    const r = REFUSALS['refund_window_closed'];
    expect(refundFailureView({ status: 409, code: r.code, message: r.message })).toEqual({
      title: 'Nothing was refunded',
      message: r.message,
    });
  });
});

describe('the facade and the override reason', () => {
  it('passes override_reason to the payments call and nothing else new', async () => {
    const seen = vi.fn();
    const { facade } = world((i) => {
      seen(i);
      return Promise.resolve(ok({ refund_request_id: 'rfr_1' }));
    });
    await facade.request({
      actor: OP,
      unit_id: UNIT,
      amount_minor: null,
      reason: 'goodwill',
      override_reason: 'ticket 4411 goodwill',
    });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0]).toMatchObject({
      unit_id: UNIT,
      reason: 'goodwill',
      override_reason: 'ticket 4411 goodwill',
    });
  });

  it('leaves override_reason out of the call when none was given', async () => {
    const seen = vi.fn();
    const { facade } = world((i) => {
      seen(i);
      return Promise.resolve(ok({ refund_request_id: 'rfr_1' }));
    });
    await facade.request({ actor: OP, unit_id: UNIT, amount_minor: null, reason: 'goodwill' });
    expect('override_reason' in (seen.mock.calls[0]![0] as object)).toBe(false);
  });

  it('answers refund_window_closed and audits the attempt with that outcome', async () => {
    const { facade, audits } = world(() => Promise.resolve(err({ code: 'refund_window_closed' })));
    const r: Result<unknown, { code: string }> = await facade.request({
      actor: OP,
      unit_id: UNIT,
      amount_minor: null,
      reason: 'goodwill',
    });
    expect(r).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'refund.attempt',
      detail: { outcome: 'refund_window_closed' },
    });
  });

  it('never writes the override reason into the attempt audit row', async () => {
    const { facade, audits } = world(() => Promise.resolve(err({ code: 'refund_window_closed' })));
    await facade.request({
      actor: OP,
      unit_id: UNIT,
      amount_minor: null,
      reason: 'goodwill',
      override_reason: 'CANARY-FACADE-OVERRIDE',
    });
    expect(JSON.stringify(audits)).not.toContain('CANARY-FACADE-OVERRIDE');
  });
});
