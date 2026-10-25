// CO-8 unit: the dry-run order model answers refund_capture and get_refund and lists the refunds on
// GET order, so the refund journey runs offline. Synthetic answers, not PayPal evidence.
import { describe, expect, it } from 'vitest';
import type { OutboundRequest } from '@umsbx/contracts';
import { createDryRunModel } from './dryrun-model';

const clock = { now: () => new Date('2026-10-25T10:00:00Z') };
interface Answer {
  status: number;
  body: unknown;
}
/** Reads a path out of a JSON value; unknown when any step is missing. */
const at = (v: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((a, k) => (a as Record<string | number, unknown> | undefined)?.[k], v);
const str = (v: unknown): string => String(v);

function world(scenario = 'happy') {
  const m = createDryRunModel(clock);
  const send = (
    operation: OutboundRequest['operation'],
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    rid: string | null = null,
  ): Answer => {
    const out = m.send({
      operation,
      method,
      path,
      headers: rid === null ? {} : { 'PayPal-Request-Id': rid },
      body: body === null ? null : JSON.stringify(body),
      order_ref: null,
      amount_minor: null,
      scenario: null,
    });
    return out.kind === 'response'
      ? { status: out.status, body: JSON.parse(out.body) as unknown }
      : { status: 0, body: {} };
  };
  const created = send(
    'create_order',
    'POST',
    '/v2/checkout/orders',
    {
      purchase_units: [
        {
          reference_id: 'u1',
          custom_id: 'ord_x',
          amount: { currency_code: 'USD', value: '4.50' },
          payee: { merchant_id: 'M1' },
        },
      ],
    },
    'create-1',
  );
  const id = str(at(created.body, 'id'));
  m.approve(id, scenario);
  const captured = send('capture_order', 'POST', `/v2/checkout/orders/${id}/capture`, {}, 'cap-1');
  const cap = str(at(captured.body, 'purchase_units', 0, 'payments', 'captures', 0, 'id'));
  const refund = (value: string | null, rid: string | null): Answer =>
    send(
      'refund_capture',
      'POST',
      `/v2/payments/captures/${cap}/refund`,
      value === null ? {} : { amount: { currency_code: 'USD', value }, note_to_payer: 'test' },
      rid,
    );
  const order = (): unknown => send('get_order', 'GET', `/v2/checkout/orders/${id}`, null).body;
  return { send, cap, refund, order };
}

describe('dry-run model refunds', () => {
  it('a partial refund is COMPLETED with a refund id, the capture reads PARTIALLY_REFUNDED and the order lists it', () => {
    const w = world();
    const r = w.refund('1.50', 'rf-1');
    expect(r.status).toBe(201);
    expect(at(r.body, 'status')).toBe('COMPLETED');
    expect(str(at(r.body, 'id'))).toMatch(/^SBXMODELREF[0-9]{6}$/);
    expect(at(r.body, 'amount')).toEqual({ currency_code: 'USD', value: '1.50' });
    expect(JSON.stringify(at(r.body, 'links'))).toContain(`/v2/payments/captures/${w.cap}`);
    const pay = at(w.order(), 'purchase_units', 0, 'payments');
    expect(at(pay, 'captures', 0, 'status')).toBe('PARTIALLY_REFUNDED');
    expect(at(pay, 'captures', 0, 'seller_receivable_breakdown', 'total_refunded_amount')).toEqual({
      currency_code: 'USD',
      value: '1.50',
    });
    expect(at(pay, 'refunds')).toHaveLength(1);
    expect(at(pay, 'refunds', 0)).toMatchObject({
      id: at(r.body, 'id'),
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '1.50' },
    });
  });
  it('the rest makes the capture REFUNDED; nothing more can be refunded', () => {
    const w = world();
    w.refund('1.50', 'rf-1');
    expect(w.refund('3.00', 'rf-2').status).toBe(201);
    expect(at(w.order(), 'purchase_units', 0, 'payments', 'captures', 0, 'status')).toBe(
      'REFUNDED',
    );
    const more = w.refund('0.01', 'rf-3');
    expect(more.status).toBe(422);
    expect(JSON.stringify(more.body)).toContain('Synthetic model answer');
  });
  it('an amount above what is left is 422 and changes nothing', () => {
    const w = world();
    w.refund('4.00', 'rf-1');
    expect(w.refund('0.51', 'rf-2').status).toBe(422);
    expect(at(w.order(), 'purchase_units', 0, 'payments', 'refunds')).toHaveLength(1);
  });
  it('the same request id replays the first answer and refunds once', () => {
    const w = world();
    const a = w.refund('1.00', 'rf-same');
    const b = w.refund('1.00', 'rf-same');
    expect(at(b.body, 'id')).toBe(at(a.body, 'id'));
    expect(at(w.order(), 'purchase_units', 0, 'payments', 'refunds')).toHaveLength(1);
  });
  it('no amount refunds what is left', () => {
    const w = world();
    w.refund('1.00', 'rf-1');
    expect(at(w.refund(null, 'rf-2').body, 'amount')).toEqual({
      currency_code: 'USD',
      value: '3.50',
    });
  });
  it('get_refund reads the refund; an unknown refund or capture is 404', () => {
    const w = world();
    const r = w.refund('1.00', 'rf-1');
    const got = w.send('get_refund', 'GET', `/v2/payments/refunds/${str(at(r.body, 'id'))}`, null);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      id: at(r.body, 'id'),
      status: 'COMPLETED',
      amount: { value: '1.00' },
    });
    expect(JSON.stringify(at(got.body, 'links'))).toContain(`/v2/payments/captures/${w.cap}`);
    expect(w.send('get_refund', 'GET', '/v2/payments/refunds/SBXMODELREF999999', null).status).toBe(
      404,
    );
    expect(
      w.send('refund_capture', 'POST', '/v2/payments/captures/NOSUCHCAP/refund', {}, 'x-1').status,
    ).toBe(404);
  });
  it('a capture that never completed cannot be refunded', () => {
    const w = world('declined');
    expect(w.refund('1.00', 'rf-1').status).toBe(422);
  });
});
