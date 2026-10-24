// BU-6: the owner-run subject stops by itself. Each lock missing stops the suite at the first call
// with the blocked reason and no Wire call; a call over the cap or an amount over 1.00 USD is
// refused by the subject before it reaches the transport. All doubles, no socket, no environment.
import { describe, expect, it } from 'vitest';
import { makeSecret } from '@umsbx/config';
import type {
  BlockReason,
  Clock,
  OutboundRequest,
  Transport,
  TransportResult,
} from '@umsbx/contracts';
import { fakeClock, ownerSubset, sandboxSubject } from './index';

const OWN = 'SBXOWNMERCH01';
const clock = (): Clock => fakeClock('2026-11-02T08:30:00.000Z' as never);
const creds = () => ({
  client_id: makeSecret('placeholder-client-id'),
  client_secret: makeSecret('placeholder-client-secret'),
});

const ok = (body: unknown, status = 200): TransportResult => ({
  kind: 'response',
  status,
  headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbgadv000001' },
  body: JSON.stringify(body),
  duration_ms: 1,
});

/** The sealed transport of the unseal: answers blocked with a reason and never touches the Wire. */
function sealed(by: BlockReason) {
  const wire: unknown[] = [];
  const sent: OutboundRequest[] = [];
  const transport: Transport = {
    kind: 'sandbox',
    async send(r) {
      sent.push(r);
      return { kind: 'blocked', by };
    },
  };
  return { transport, wire, sent };
}

/** A transport that accepts everything, counting what reaches it. */
function open() {
  const sent: OutboundRequest[] = [];
  const transport: Transport = {
    kind: 'sandbox',
    async send(r) {
      sent.push(r);
      if (r.operation === 'oauth_token') {
        return ok({ access_token: 'placeholder-token-abcdef', expires_in: 32400 });
      }
      if (r.operation === 'create_order') {
        return ok(
          {
            id: 'ORDER00AAAAAA',
            status: 'CREATED',
            links: [
              {
                href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER00AAAAAA',
                rel: 'approve',
                method: 'GET',
              },
            ],
          },
          201,
        );
      }
      return ok({
        id: 'ORDER00AAAAAA',
        status: 'CREATED',
        purchase_units: [
          {
            reference_id: 'unit-1',
            custom_id: 'ord_x',
            amount: { currency_code: 'USD', value: '1.00' },
            payee: { merchant_id: OWN },
          },
        ],
        create_time: '2026-11-02T08:30:00Z',
        update_time: '2026-11-02T08:30:00Z',
      });
    },
  };
  return { transport, sent };
}

const subjectOver = (transport: Transport) => {
  const lines: string[] = [];
  const subject = sandboxSubject({
    transport,
    clock: clock(),
    credentials: creds(),
    own_merchant_id: OWN,
    stderr: (l) => lines.push(l),
    sleep: async () => undefined,
  });
  return { subject, lines };
};

describe('each lock missing stops the suite at the first call', () => {
  const locks: [string, BlockReason][] = [
    ['L1/L2 mode or connect flag', 'connect_off'],
    ['L3 no active approval', 'no_approval'],
    ['L4 kill switch', 'kill_switch'],
    ['L5 credentials or Wire not clean', 'egress'],
    ['budget spent', 'budget'],
  ];
  it.each(locks)(
    '%s: reason %s, one transport call, 0 Wire calls, nothing after',
    async (_n, by) => {
      const s = sealed(by);
      const { subject } = subjectOver(s.transport);
      const run = ownerSubset(subject);
      const report = await run.runAll();
      expect(report.stopped?.code).toBe(by);
      expect(subject.stopped()?.code).toBe(by);
      expect(s.sent).toHaveLength(1);
      expect(s.sent[0]?.operation).toBe('oauth_token');
      expect(s.wire).toHaveLength(0);
      expect(report.cases.every((c) => !c.pass)).toBe(true);
      expect(report.cases[0]?.detail).toContain(by);
      expect(report.payee_echo).toBe('STOP');
    },
  );
  it('the reason is said once in the detail of the first case', async () => {
    const s = sealed('connect_off');
    const { subject } = subjectOver(s.transport);
    const report = await ownerSubset(subject).runAll();
    expect(report.cases[0]?.detail).toBe('create answered blocked (connect_off)');
    expect(report.stopped?.detail).toBe('blocked by connect_off');
  });
  it('a later call on the same subject is answered blocked without reaching the transport', async () => {
    const s = sealed('kill_switch');
    const { subject } = subjectOver(s.transport);
    const { port } = await subject.make();
    await port.getOrder('ORDER00123456');
    expect(s.sent).toHaveLength(1);
    const again = await port.getOrder('ORDER00123456');
    expect(again.kind).toBe('blocked');
    const other = await subject.make();
    await other.port.getOrder('ORDER00123456');
    expect(s.sent).toHaveLength(1);
  });
  it('a lock that closes in the middle of the run stops everything after it', async () => {
    const o = open();
    let calls = 0;
    const transport: Transport = {
      kind: 'sandbox',
      async send(r) {
        calls += 1;
        return calls >= 4 ? { kind: 'blocked', by: 'no_approval' } : o.transport.send(r);
      },
    };
    const { subject } = subjectOver(transport);
    const report = await ownerSubset(subject).runAll();
    expect(report.stopped?.code).toBe('no_approval');
    expect(calls).toBe(4);
  });
});

describe('the caps of the subject', () => {
  it('refuses the 21st call of one order and stops, without reaching the transport', async () => {
    const o = open();
    const { subject } = subjectOver(o.transport);
    const { port } = await subject.make();
    const results: string[] = [];
    for (let i = 0; i < 25; i += 1) results.push((await port.getOrder('ORDER00AAAAAA')).kind);
    expect(o.sent).toHaveLength(20);
    expect(results.slice(0, 19).every((k) => k === 'order')).toBe(true);
    expect(results.slice(19).every((k) => k === 'blocked')).toBe(true);
    expect(subject.stopped()?.code).toBe('call_cap');
  });
  it('the cap is per order: a fresh make() starts a fresh count', async () => {
    const o = open();
    const { subject } = subjectOver(o.transport);
    const a = await subject.make();
    for (let i = 0; i < 10; i += 1) await a.port.getOrder('ORDER00AAAAAA');
    const b = await subject.make();
    for (let i = 0; i < 10; i += 1) await b.port.getOrder('ORDER00AAAAAA');
    expect(subject.stopped()).toBeNull();
  });
  it('approval polls are not counted against the 20 but are capped at 24', async () => {
    const o = open();
    const { subject } = subjectOver(o.transport);
    const { hooks } = await subject.make();
    await expect(
      hooks.approve('ORDER00AAAAAA', 'https://www.sandbox.paypal.com/checkoutnow?token=X'),
    ).rejects.toThrow(/did not approve/);
    expect(o.sent.filter((r) => r.operation === 'get_order')).toHaveLength(24);
    expect(subject.stopped()).toBeNull();
  });
  it('refuses an amount above 1.00 USD: the create never reaches the transport', async () => {
    const o = open();
    const { subject } = subjectOver(o.transport);
    const { port } = await subject.make();
    const req = subject.orderRequest();
    const big = {
      ...req,
      units: req.units.map((u) => ({ ...u, amount: { currency: 'USD' as const, minor: 101 } })),
    };
    const res = await port.createOrder(big);
    expect(res.kind).toBe('blocked');
    expect(o.sent.some((r) => r.operation === 'create_order')).toBe(false);
    expect(subject.stopped()?.code).toBe('amount_cap');
  });
  it('accepts exactly 1.00 USD', async () => {
    const o = open();
    const { subject } = subjectOver(o.transport);
    const { port } = await subject.make();
    const res = await port.createOrder(subject.orderRequest());
    expect(res.kind).toBe('created');
    expect(subject.stopped()).toBeNull();
  });
  it('checks the body too: a request whose amount_minor says 1.00 but whose body asks for more is refused', async () => {
    const o = open();
    const { subject } = subjectOver(o.transport);
    const { transport } = await subject.make();
    const lie: OutboundRequest = {
      operation: 'create_order',
      method: 'POST',
      path: '/v2/checkout/orders',
      headers: { 'content-type': 'application/json', 'paypal-request-id': 'umsC-lie-1' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          { reference_id: 'unit-1', amount: { currency_code: 'USD', value: '25.00' } },
        ],
      }),
      order_ref: null,
      amount_minor: 100,
      scenario: null,
    };
    const res = await transport.send(lie);
    expect(res).toEqual({ kind: 'blocked', by: 'budget' });
    expect(o.sent).toHaveLength(0);
  });
  it('refuses a currency other than USD', async () => {
    const o = open();
    const { subject } = subjectOver(o.transport);
    const { transport } = await subject.make();
    const eur: OutboundRequest = {
      operation: 'create_order',
      method: 'POST',
      path: '/v2/checkout/orders',
      headers: { 'content-type': 'application/json', 'paypal-request-id': 'umsC-eur-1' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          { reference_id: 'unit-1', amount: { currency_code: 'EUR', value: '1.00' } },
        ],
      }),
      order_ref: null,
      amount_minor: 100,
      scenario: null,
    };
    expect(await transport.send(eur)).toEqual({ kind: 'blocked', by: 'budget' });
    expect(o.sent).toHaveLength(0);
  });
  it('refuses an operation outside the five of the polling phase', async () => {
    const o = open();
    const { subject } = subjectOver(o.transport);
    const { transport } = await subject.make();
    const refund: OutboundRequest = {
      operation: 'refund_capture',
      method: 'POST',
      path: '/v2/payments/captures/CAP123/refund',
      headers: { 'content-type': 'application/json', 'paypal-request-id': 'umsR-1' },
      body: '{}',
      order_ref: null,
      amount_minor: 100,
      scenario: null,
    };
    expect((await transport.send(refund)).kind).toBe('blocked');
    expect(o.sent).toHaveLength(0);
  });
});

describe('the lost answer is discarded once, after the call returned', () => {
  it('only the next capture, only once', async () => {
    const sent: OutboundRequest[] = [];
    const transport: Transport = {
      kind: 'sandbox',
      async send(r) {
        sent.push(r);
        if (r.operation === 'oauth_token') {
          return ok({ access_token: 'placeholder-token-abcdef', expires_in: 32400 });
        }
        return ok({ id: 'ORDER00AAAAAA', status: 'COMPLETED' }, 201);
      },
    };
    const { subject } = subjectOver(transport);
    const { transport: guarded } = await subject.make();
    subject.discardNextCaptureAnswer();
    const cap: OutboundRequest = {
      operation: 'capture_order',
      method: 'POST',
      path: '/v2/checkout/orders/ORDER00AAAAAA/capture',
      headers: { 'content-type': 'application/json', 'paypal-request-id': 'umsC-cap-1' },
      body: '{}',
      order_ref: null,
      amount_minor: null,
      scenario: null,
    };
    const first = await guarded.send(cap);
    const second = await guarded.send(cap);
    expect(first).toEqual({ kind: 'timeout' });
    expect(second.kind).toBe('response');
    expect(sent.filter((r) => r.operation === 'capture_order')).toHaveLength(2);
  });
});
