import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRequest, testDeps } from './https-fake';
import type { Script } from './https-fake';
import { createApprovedSandboxTransport } from './sandbox';
import {
  LIVE_HOST,
  SANDBOX_HOST,
  approvalFrom,
  fixedClock,
  memoryLogger,
  netSpies,
  req,
  scopedGate,
} from './test-support';
import { makeHttpsWire } from './wire-https';

// BU-1 integration: the approved sandbox transport over the node:https Wire, with an in-memory
// request function in place of the network. One send per allowed request, none for a blocked one.
let spies: ReturnType<typeof netSpies>;
beforeEach(() => {
  spies = netSpies();
});
afterEach(() => {
  vi.useRealTimers();
  spies.assertZero();
  spies.spies['global fetch'].mockRestore();
});

async function build(script?: Script, gateOver: Parameters<typeof scopedGate>[0] = {}) {
  const f = fakeRequest(script);
  const wire = makeHttpsWire(testDeps(f.request));
  const gate = scopedGate(gateOver);
  const log = memoryLogger();
  const t = await createApprovedSandboxTransport({
    approval: await approvalFrom(gate),
    scope: 'mvp_b_polling',
    wire,
    clock: fixedClock(),
    log,
  });
  return { t, calls: f.calls, gate, log };
}
const JSON_BODY = JSON.stringify({ id: 'ABC123', status: 'CREATED' });

describe('an allowed request is sent exactly once', () => {
  it('get_order: one request to the sandbox host, the response comes back', async () => {
    const { t, calls, gate } = await build({
      kind: 'response',
      headers: { 'Content-Type': 'application/json', 'PayPal-Debug-Id': 'dbg123' },
      chunks: [JSON_BODY],
    });
    const r = await t.send(req('get_order', '/v2/checkout/orders/ABC123'));
    expect(r).toMatchObject({ kind: 'response', status: 200, body: JSON_BODY });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toMatchObject({
      hostname: SANDBOX_HOST,
      servername: SANDBOX_HOST,
      path: '/v2/checkout/orders/ABC123',
      method: 'GET',
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    expect(gate.checks).toHaveLength(1);
  });
  it('a POST that moves money carries the canonical body once', async () => {
    const body = JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: '4.99' } }],
    });
    const { t, calls } = await build();
    const r = await t.send(
      req('create_order', '/v2/checkout/orders', {
        body,
        amount_minor: 499,
        headers: { authorization: 'Bearer placeholder', 'content-type': 'application/json' },
      }),
    );
    expect(r.kind).toBe('response');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe(body);
  });
  it('Host and method-override headers are dropped before the Wire', async () => {
    const { t, calls } = await build();
    await t.send(
      req('get_order', '/v2/checkout/orders/ABC123', {
        headers: {
          Host: 'evil.example',
          'X-HTTP-Method-Override': 'DELETE',
          Authorization: 'Bearer t',
        },
      }),
    );
    expect(Object.keys(calls[0]?.options['headers'] as object)).toEqual(['authorization']);
  });
});

describe('a blocked request never reaches the request function', () => {
  it('the egress guard refuses a live host: zero requests', async () => {
    const { t, calls } = await build();
    const r = await t.send(req('get_order', `https://${LIVE_HOST}/v2/checkout/orders/ABC123`));
    expect(r).toEqual({ kind: 'blocked', by: 'egress' });
    expect(calls).toHaveLength(0);
  });
  it('a denying gate refuses: zero requests', async () => {
    const { t, calls } = await build(undefined, {
      verdict: () => ({ allowed: false, by: 'kill_switch' }),
    });
    const r = await t.send(req('get_order', '/v2/checkout/orders/ABC123'));
    expect(r).toEqual({ kind: 'blocked', by: 'kill_switch' });
    expect(calls).toHaveLength(0);
  });
  it('an operation outside the scope is refused: zero requests', async () => {
    const { t, calls } = await build();
    const r = await t.send(
      req('refund_capture', '/v2/payments/captures/CAP1/refund', { amount_minor: 100 }),
    );
    expect(r.kind).toBe('blocked');
    expect(calls).toHaveLength(0);
  });
  it('a port, userinfo or http URL is refused by the guard: zero requests', async () => {
    const { t, calls } = await build();
    for (const path of [
      `https://${SANDBOX_HOST}:8443/v2/checkout/orders/ABC123`,
      `https://user:pw@${SANDBOX_HOST}/v2/checkout/orders/ABC123`,
      `http://${SANDBOX_HOST}/v2/checkout/orders/ABC123`,
    ])
      expect((await t.send(req('get_order', path))).kind).toBe('blocked');
    expect(calls).toHaveLength(0);
  });
});

describe('what the Wire returns is mapped by the transport', () => {
  it('a 302 is a redirect error and its Location is never requested', async () => {
    const { t, calls } = await build({
      kind: 'response',
      status: 302,
      headers: { Location: 'https://elsewhere.invalid/x' },
    });
    const r = await t.send(req('get_order', '/v2/checkout/orders/ABC123'));
    expect(r).toEqual({ kind: 'network_error', code: 'redirect' });
    expect(calls).toHaveLength(1);
  });
  it('a body over 1 MiB is response_too_large', async () => {
    const { t, calls } = await build({ kind: 'response', chunks: ['a'.repeat(1024 * 1024 + 1)] });
    const r = await t.send(req('get_order', '/v2/checkout/orders/ABC123'));
    expect(r).toEqual({ kind: 'network_error', code: 'response_too_large' });
    expect(calls[0]?.reqDestroyed).toBe(true);
  });
  it('a server that never answers is a timeout at 10 s', async () => {
    vi.useFakeTimers();
    const { t, calls } = await build({ kind: 'hang' });
    const p = t.send(req('get_order', '/v2/checkout/orders/ABC123'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toEqual({ kind: 'timeout' });
    expect(calls).toHaveLength(1);
  });
  it.each([
    ['ENOTFOUND', 'dns'],
    ['ECONNREFUSED', 'connect'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['ECONNRESET', 'reset'],
  ])('%s becomes network_error:%s and is not retried', async (code, kind) => {
    const { t, calls, log } = await build({ kind: 'request-error', code });
    const r = await t.send(req('get_order', '/v2/checkout/orders/ABC123'));
    expect(r).toEqual({ kind: 'network_error', code: kind });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(log.events)).not.toContain('Bearer');
  });
  it('set-cookie never comes back to the caller', async () => {
    const { t } = await build({
      kind: 'response',
      headers: { 'Set-Cookie': ['a=b', 'c=d'], 'Content-Type': 'application/json' },
      chunks: ['{}'],
    });
    const r = await t.send(req('get_order', '/v2/checkout/orders/ABC123'));
    expect(r.kind === 'response' && Object.keys(r.headers)).toEqual(['content-type']);
  });
});
