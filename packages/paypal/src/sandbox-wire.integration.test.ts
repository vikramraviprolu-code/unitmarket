import { afterEach, describe, expect, it } from 'vitest';
import { claimApprovalMinter, createApprovedSandboxTransport } from '@umsbx/transport';
import type { Wire, WireRequest, WireResult } from '@umsbx/transport';
import { createPayPalAdapter } from './adapter';
import type { ProviderCallRecord } from './adapter';
import { createReq, memoryLogger, mutableClock, secret } from './test-support';

// B-L1: the adapter and its OAuth cache over the real sandbox Transport, with a fake Wire only.
// Credentials are obviously fake placeholders built at runtime; nothing reads the environment.
const FAKE_ID = ['placeholder', 'client', 'id'].join('-');
const FAKE_SECRET = ['placeholder', 'client', 'secret'].join('-');
const BASIC = Buffer.from(`${FAKE_ID}:${FAKE_SECRET}`).toString('base64');
const HOST = ['api-m', 'sandbox', 'paypal', 'com'].join('.');

// Only packages/transport may touch network modules (lint S2), so this file cannot spy on them.
// The transport package's own tests do (netSpies); here the Wire is a fake and the production
// Wire is never constructed, so no socket can exist.
afterEach(() => {
  const open = process
    .getActiveResourcesInfo()
    .filter((r) => r === 'TCPSocketWrap' || r === 'TCPConnectWrap' || r === 'TLSWrap');
  expect(open).toEqual([]);
});

// This test file never loads @umsbx/safety, so its module registry is free to claim the minter
// with a permissive predicate (a named lint exemption, pinned in scripts/lint-rules.test.ts). In
// the product, safety claims it first and vouches only for its own gates (FIX-MVPB-SEAL2 H1).
const mintApprovalCapability = claimApprovalMinter(() => true);

const json = (status: number, body: unknown): WireResult => ({
  kind: 'response',
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function setup(handler: (r: WireRequest, n: number) => WireResult) {
  const seen: WireRequest[] = [];
  const wire: Wire = {
    async request(r) {
      seen.push(structuredClone(r));
      return handler(r, seen.length);
    },
  };
  const approval = mintApprovalCapability({
    scope: 'mvp_c_refunds',
    approval_ref: 'appr',
    gate: { check: async () => ({ allowed: true, approval_ref: 'appr' }) },
  });
  const clock = mutableClock();
  const transport = await createApprovedSandboxTransport({
    approval,
    scope: 'mvp_c_refunds',
    wire,
    clock,
    log: memoryLogger(),
  });
  const records: ProviderCallRecord[] = [];
  const adapter = createPayPalAdapter({
    transport,
    clock,
    log: memoryLogger(),
    credentials: { client_id: secret(FAKE_ID), client_secret: secret(FAKE_SECRET) },
    record: async (c) => {
      records.push(c);
    },
  });
  return { seen, adapter, clock, records };
}

const token = (n: number, expires_in = 3600) =>
  json(200, { access_token: `fake-token-${n}`, token_type: 'Bearer', expires_in });

describe('OAuth through the sandbox transport', () => {
  it('first call: token request is exactly Basic + client_credentials, then the resource call carries the Bearer', async () => {
    const { seen, adapter } = await setup((r) =>
      r.url.endsWith('/v1/oauth2/token') ? token(1) : json(404, { name: 'RESOURCE_NOT_FOUND' }),
    );
    await adapter.getOrder('ABC123');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      method: 'POST',
      url: `https://${HOST}/v1/oauth2/token`,
      headers: {
        authorization: `Basic ${BASIC}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      timeout_ms: 10_000,
    });
    expect(seen[1]?.headers.authorization).toBe('Bearer fake-token-1');
  });

  it('token cached in memory: refresh exactly at expiry minus 300 s, single flight under 20 callers', async () => {
    let tokens = 1;
    const { seen, adapter, clock } = await setup((r) =>
      r.url.endsWith('/v1/oauth2/token') ? token(tokens++, 3600) : json(404, {}),
    );
    await Promise.all(Array.from({ length: 20 }, () => adapter.getOrder('ABC123')));
    const tokenCalls = () => seen.filter((r) => r.url.endsWith('/v1/oauth2/token')).length;
    expect(tokenCalls()).toBe(1);
    clock.advance((3600 - 300) * 1000 - 1);
    await adapter.getOrder('ABC123');
    expect(tokenCalls()).toBe(1);
    clock.advance(1);
    await Promise.all(Array.from({ length: 20 }, () => adapter.getOrder('ABC123')));
    expect(tokenCalls()).toBe(2);
    expect(seen.at(-1)?.headers.authorization).toBe('Bearer fake-token-2');
  });

  it('a 401 on a read drops the token and retries the read once with a new token; a 401 on a POST is not retried', async () => {
    let t = 0;
    const { seen, adapter } = await setup((r) => {
      if (r.url.endsWith('/v1/oauth2/token')) return token(++t);
      return r.headers.authorization === 'Bearer fake-token-2'
        ? json(404, {})
        : json(401, { name: 'AUTHENTICATION_FAILURE' });
    });
    await adapter.getOrder('ABC123');
    expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'POST /v1/oauth2/token',
      'GET /v2/checkout/orders/ABC123',
      'POST /v1/oauth2/token',
      'GET /v2/checkout/orders/ABC123',
    ]);
    seen.length = 0;
    t = 5;
    const { seen: s2, adapter: a2 } = await setup((r) =>
      r.url.endsWith('/v1/oauth2/token')
        ? token(++t)
        : json(401, { name: 'AUTHENTICATION_FAILURE' }),
    );
    await a2.captureOrder({ provider_order_id: 'ABC123', request_id: 'umsK-1', scenario: null });
    expect(s2.filter((r) => r.method === 'POST' && r.url.endsWith('/capture'))).toHaveLength(1);
  });

  it('a token failure is a blocked-or-unavailable result and writes no token anywhere', async () => {
    const { adapter, records } = await setup(() => json(401, { error: 'invalid_client' }));
    const res = await adapter.getOrder('ABC123');
    expect(res.kind).not.toBe('order');
    const text = JSON.stringify(records);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toContain(BASIC);
  });
});

describe('exact bytes for create, get, capture and refund through the adapter', () => {
  it('sends the OpenAPI shapes on the wire', async () => {
    const { seen, adapter, records } = await setup((r) =>
      r.url.endsWith('/v1/oauth2/token') ? token(1) : json(500, {}),
    );
    await adapter.createOrder(createReq());
    await adapter.getOrder('5O190127TN364715T');
    await adapter.captureOrder({
      provider_order_id: '5O190127TN364715T',
      request_id: 'umsK-cap-1',
      scenario: null,
    });
    await adapter.getCapture('3C679366HH908993F');
    await adapter.refundCapture({
      capture_id: '3C679366HH908993F',
      request_id: 'umsR-ref-1',
      amount: { currency: 'USD', minor: 500 },
      note: '',
    });
    const view = seen.slice(1).map((r) => ({
      m: r.method,
      u: r.url,
      h: r.headers,
      b: r.body === null ? null : (JSON.parse(r.body) as unknown),
    }));
    const bearer = { authorization: 'Bearer fake-token-1', accept: 'application/json' };
    const post = (id: string) => ({
      ...bearer,
      'content-type': 'application/json',
      prefer: 'return=representation',
      'paypal-request-id': id,
    });
    expect(view.map((v) => [v.m, v.u])).toEqual([
      ['POST', `https://${HOST}/v2/checkout/orders`],
      ['GET', `https://${HOST}/v2/checkout/orders/5O190127TN364715T`],
      ['POST', `https://${HOST}/v2/checkout/orders/5O190127TN364715T/capture`],
      ['GET', `https://${HOST}/v2/payments/captures/3C679366HH908993F`],
      ['POST', `https://${HOST}/v2/payments/captures/3C679366HH908993F/refund`],
    ]);
    expect(view[0]?.h).toEqual(post(createReq().request_id));
    expect(view[1]?.h).toEqual(bearer);
    expect(view[2]?.h).toEqual(post('umsK-cap-1'));
    expect(view[3]?.h).toEqual(bearer);
    expect(view[4]?.h).toEqual(post('umsR-ref-1'));
    expect(view[1]?.b).toBeNull();
    expect(view[2]?.b).toEqual({});
    expect(view[4]?.b).toEqual({ amount: { currency_code: 'USD', value: '5.00' } });
    expect(view[0]?.b).toMatchObject({
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: 'unit-1', amount: { currency_code: 'USD', value: '5.00' } }],
    });
    const text = JSON.stringify(records);
    expect(text).not.toContain('fake-token-1');
    expect(text).not.toContain(BASIC);
  });
});
