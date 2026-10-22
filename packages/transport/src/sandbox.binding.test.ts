import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApprovedSandboxTransport, SCOPE_OPERATIONS } from './sandbox';
import {
  approvalFrom,
  fakeWire,
  fixedClock,
  memoryLogger,
  netSpies,
  req,
  scopedGate,
} from './test-support';
import { bodyAmountMinor } from './amount-binding';
import type { OutboundRequest, PayPalOperation } from '@umsbx/contracts';
import type { FakeGate } from './test-support';

// FIX-BPREP M2 (per-request approval and scope binding), M4 (amount binding and per-scope
// operation limits), L3 (certificate fetch) and OBS (the sandbox.send log line). Fake Wire only.
let spies: ReturnType<typeof netSpies>;
beforeEach(() => {
  spies = netSpies();
});
afterEach(() => {
  spies.assertZero();
  spies.spies['global fetch'].mockRestore();
});

const body = (value: string, currency = 'USD') =>
  JSON.stringify({ purchase_units: [{ amount: { currency_code: currency, value } }] });
const create = (over: Partial<OutboundRequest> = {}) =>
  req('create_order', '/v2/checkout/orders', { body: body('5.00'), amount_minor: 500, ...over });
const refund = (over: Partial<OutboundRequest> = {}) =>
  req('refund_capture', '/v2/payments/captures/3C679366HH908993F/refund', {
    body: JSON.stringify({ amount: { currency_code: 'USD', value: '5.00' } }),
    amount_minor: 500,
    ...over,
  });

async function build(
  o: { scope?: string; gate?: FakeGate; wire?: ReturnType<typeof fakeWire> } = {},
) {
  const scope = o.scope ?? 'mvp_b_polling';
  const gate = o.gate ?? scopedGate({ scope });
  const wire = o.wire ?? fakeWire();
  const log = memoryLogger();
  const t = await createApprovedSandboxTransport({
    approval: await approvalFrom(gate),
    scope,
    wire,
    clock: fixedClock(),
    log,
  });
  return { t, gate, wire, log };
}

describe('M2: the verdict and the request are bound to the construction-time approval', () => {
  it('passes scope and approval_ref to the gate on every check', async () => {
    const { t, gate } = await build();
    await t.send(req('get_order', '/v2/checkout/orders/ABC123'));
    expect(gate.checks[0]).toMatchObject({ scope: 'mvp_b_polling', approval_ref: 'appr-test' });
  });
  it('blocks no_approval and sends nothing when the gate allows on a different approval_ref', async () => {
    const gate = scopedGate({ verdict: () => ({ allowed: true, approval_ref: 'another-row' }) });
    const { t, wire, log } = await build({ gate });
    const r = await t.send(req('get_order', '/v2/checkout/orders/ABC123'));
    expect(r).toEqual({ kind: 'blocked', by: 'no_approval' });
    expect(wire.requests).toHaveLength(0);
    expect(log.events.at(-1)?.fields['reason']).toBe('approval_ref_mismatch');
  });
});

describe('M4: operations are limited per scope by the transport itself', () => {
  it('mvp_b_polling lists exactly oauth, create, get, capture and get_capture', () => {
    expect([...(SCOPE_OPERATIONS['mvp_b_polling'] ?? [])].sort()).toEqual(
      ['capture_order', 'create_order', 'get_capture', 'get_order', 'oauth_token'].sort(),
    );
  });
  const forbidden: OutboundRequest[] = [
    refund(),
    req('get_refund', '/v2/payments/refunds/ABC123'),
    req('verify_webhook_postback', '/v1/notifications/verify-webhook-signature'),
    req('fetch_webhook_cert', 'https://api.sandbox.paypal.com/v1/notifications/certs/C1', {
      method: 'GET',
      body: null,
    }),
  ];
  it.each(forbidden.map((r) => [r.operation, r] as const))(
    'a polling transport blocks %s even though the gate would allow it',
    async (_op, r) => {
      const { t, wire, gate } = await build();
      expect(await t.send(r)).toEqual({ kind: 'blocked', by: 'no_approval' });
      expect(wire.requests).toHaveLength(0);
      expect(gate.checks).toHaveLength(0);
    },
  );
  it.each(['oauth_token', 'get_order', 'get_capture', 'capture_order'] as PayPalOperation[])(
    'a polling transport still sends %s',
    async (op) => {
      const path: Record<string, string> = {
        oauth_token: '/v1/oauth2/token',
        get_order: '/v2/checkout/orders/ABC123',
        get_capture: '/v2/payments/captures/ABC123',
        capture_order: '/v2/checkout/orders/ABC123/capture',
      };
      const { t, wire } = await build();
      expect((await t.send(req(op, path[op] as string))).kind).toBe('response');
      expect(wire.requests).toHaveLength(1);
    },
  );
});

describe('M4: amount_minor must equal the amount in the body for money-moving posts', () => {
  const bad: [string, OutboundRequest][] = [
    ['create with null amount', create({ amount_minor: null })],
    ['create body asks for more than declared', create({ body: body('500.00') })],
    ['create body asks for less than declared', create({ body: body('0.01') })],
    ['create body has no amount', create({ body: '{"purchase_units":[{}]}' })],
    ['create body not json', create({ body: 'amount=5.00' })],
    ['create body has no purchase units', create({ body: '{}' })],
    ['create value with a sign', create({ body: body('-5.00') })],
    ['create value with an exponent', create({ body: body('5e2') })],
    ['create value too many decimals', create({ body: body('5.001') })],
    [
      'create mixed currency units',
      create({
        body: JSON.stringify({
          purchase_units: [
            { amount: { currency_code: 'USD', value: '2.50' } },
            { amount: { currency_code: 'EUR', value: '2.50' } },
          ],
        }),
      }),
    ],
  ];
  it.each(bad)('blocks: %s', async (_n, r) => {
    const { t, wire, gate, log } = await build();
    expect(await t.send(r)).toEqual({ kind: 'blocked', by: 'egress' });
    expect(wire.requests).toHaveLength(0);
    expect(gate.checks).toHaveLength(0);
    expect(log.events.at(-1)?.fields['reason']).toBe('amount_unbound');
  });
  const badRefund: [string, OutboundRequest][] = [
    ['refund with null amount (a full refund by omission)', refund({ amount_minor: null })],
    ['refund body without an amount', refund({ body: '{}' })],
    ['refund body differs from declared', refund({ amount_minor: 100 })],
  ];
  it.each(badRefund)('blocks on the wide scope: %s', async (_n, r) => {
    const { t, wire, gate } = await build({ scope: 'mvp_c_refunds' });
    expect(await t.send(r)).toEqual({ kind: 'blocked', by: 'egress' });
    expect(wire.requests).toHaveLength(0);
    expect(gate.checks).toHaveLength(0);
  });
  it('sums several units of one currency and sends when it equals the declared amount', async () => {
    const { t, wire } = await build();
    const two = JSON.stringify({
      purchase_units: [
        { amount: { currency_code: 'USD', value: '2.50' } },
        { amount: { currency_code: 'USD', value: '0.75' } },
      ],
    });
    expect((await t.send(create({ body: two, amount_minor: 325 }))).kind).toBe('response');
    expect(wire.requests).toHaveLength(1);
  });
  it('a zero-decimal currency is read with exponent 0', () => {
    expect(bodyAmountMinor('create_order', body('500', 'JPY'))).toBe(500);
    expect(bodyAmountMinor('create_order', body('500.5', 'JPY'))).toBeNull();
    expect(bodyAmountMinor('create_order', body('5.05'))).toBe(505);
    expect(bodyAmountMinor('create_order', body('0.00'))).toBe(0);
  });
  it('a matching refund passes on the wide scope', async () => {
    const { t, wire } = await build({ scope: 'mvp_c_refunds' });
    expect((await t.send(refund())).kind).toBe('response');
    expect(wire.requests).toHaveLength(1);
  });
});

describe('L3: the certificate fetch never carries our token and stays one label deep', () => {
  const cert = (host: string) =>
    req('fetch_webhook_cert', `https://${host}/v1/notifications/certs/CERT-1`, {
      method: 'GET',
      body: null,
      headers: { authorization: 'Bearer should-not-travel', accept: 'application/json' },
    });
  it('drops authorization for fetch_webhook_cert and keeps the rest', async () => {
    const { t, wire } = await build({ scope: 'mvp_c_refunds' });
    expect((await t.send(cert('api.sandbox.paypal.com'))).kind).toBe('response');
    expect(wire.requests[0]?.headers).toEqual({ accept: 'application/json' });
  });
  it('blocks a deeper host under the sandbox domain', async () => {
    const { t, wire } = await build({ scope: 'mvp_c_refunds' });
    expect(await t.send(cert('a.b.sandbox.paypal.com'))).toEqual({
      kind: 'blocked',
      by: 'egress',
    });
    expect(wire.requests).toHaveLength(0);
  });
  it('still sends authorization for ordinary calls', async () => {
    const { t, wire } = await build();
    await t.send(req('get_order', '/v2/checkout/orders/ABC123'));
    expect(wire.requests[0]?.headers['authorization']).toBeDefined();
  });
});

describe('OBS: the sandbox.send log line', () => {
  it('carries operation, outcome, status, approval_ref, a per-request correlation id, request id and the PayPal debug id', async () => {
    const wire = fakeWire(() => ({
      kind: 'response',
      status: 201,
      headers: { 'paypal-debug-id': 'dbg0123abc', 'content-type': 'application/json' },
      body: '{}',
    }));
    const { t, log } = await build({ wire });
    await t.send(
      create({
        headers: { authorization: 'Bearer fake-secret-token', 'PayPal-Request-Id': 'umsC-req-9' },
      }),
    );
    await t.send(create());
    const sends = log.events.filter((e) => e.msg === 'sandbox.send');
    expect(sends).toHaveLength(2);
    expect(sends[0]?.fields).toMatchObject({
      operation: 'create_order',
      outcome: 'response',
      status: 201,
      approval_ref: 'appr-test',
      request_id: 'umsC-req-9',
      paypal_debug_id: 'dbg0123abc',
    });
    const ids = sends.map((e) => e.fields['correlation_id']);
    expect(ids.every((i) => typeof i === 'string' && i.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });
  it('blocked calls are logged with a reason and a correlation id too', async () => {
    const { t, log } = await build();
    await t.send(refund());
    const e = log.events.at(-1);
    expect(e?.fields).toMatchObject({
      outcome: 'blocked:no_approval',
      approval_ref: 'appr-test',
      reason: 'operation_not_in_scope',
    });
    expect(typeof e?.fields['correlation_id']).toBe('string');
  });
});
