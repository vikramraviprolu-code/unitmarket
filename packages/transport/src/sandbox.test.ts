import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedSandboxTransport,
  createSandboxTransport,
  SandboxSealedError,
} from './sandbox';
import {
  SANDBOX_HOST,
  approvalFrom,
  fakeWire,
  fixedClock,
  memoryLogger,
  netSpies,
  req,
  scopedGate,
} from './test-support';
import type { OutboundRequest, Transport } from '@umsbx/contracts';
import { mintApprovalCapability } from './approval';
import type { FakeGate, FakeWire } from './test-support';
import type { WireResult } from './wire';

// B-L1. Every test uses a fake Wire. netSpies() proves no connection, lookup or fetch happens.
let spies: ReturnType<typeof netSpies>;
beforeEach(() => {
  spies = netSpies();
});
afterEach(() => {
  spies.assertZero();
  spies.spies['global fetch'].mockRestore();
});

const BASE = `https://${SANDBOX_HOST}`;
const SCOPE = 'mvp_b_polling';
const orderBody = (value: string) =>
  JSON.stringify({
    intent: 'CAPTURE',
    purchase_units: [{ amount: { currency_code: 'USD', value } }],
  });
// A create_order whose body asks for exactly the amount the caller declares (FIX-BPREP M4).
const createOrder = (over: Partial<OutboundRequest> = {}) =>
  req('create_order', '/v2/checkout/orders', {
    body: orderBody('5.00'),
    amount_minor: 500,
    ...over,
  });

async function build(
  o: {
    wire?: FakeWire;
    gate?: FakeGate;
    clock?: ReturnType<typeof fixedClock>;
    scope?: string;
  } = {},
) {
  const wire = o.wire ?? fakeWire();
  const gate = o.gate ?? scopedGate({ scope: o.scope ?? SCOPE });
  const log = memoryLogger();
  const t = await createApprovedSandboxTransport({
    approval: await approvalFrom(gate),
    scope: o.scope ?? SCOPE,
    wire,
    clock: o.clock ?? fixedClock(),
    log,
  });
  return { t, wire, gate, log };
}

describe('sealed by default', () => {
  it('createSandboxTransport() with no gate stays sealed: always blocked connect_off', async () => {
    const t = createSandboxTransport();
    expect(t.kind).toBe('sandbox');
    for (const r of [
      req('create_order', '/v2/checkout/orders'),
      req('get_order', '/v2/checkout/orders/ABC123'),
      req('get_order', 'https://evil.example/x'),
      req('oauth_token', '/v1/oauth2/token', { method: 'POST' }),
    ]) {
      await expect(t.send(r)).resolves.toEqual({ kind: 'blocked', by: 'connect_off' });
    }
  });

  it('the approved factory refuses with a named error unless it holds a minted approval capability for the scope', async () => {
    const wire = fakeWire();
    const base = { scope: SCOPE, wire, clock: fixedClock(), log: memoryLogger() };
    const gate = scopedGate();
    const forged = {
      scope: SCOPE,
      approval_ref: 'x',
      gate: { check: async () => ({ allowed: true, approval_ref: 'x' }) },
    };
    const real = await approvalFrom(gate);
    const bad: unknown[] = [
      undefined,
      {},
      { ...base },
      { ...base, approval: undefined },
      { ...base, approval: null },
      // M3: any structurally typed object is refused, only a minted capability passes.
      { ...base, approval: forged },
      { ...base, approval: { ...real } },
      { ...base, approval: Object.create(real) },
      { ...base, approval: JSON.parse(JSON.stringify(real)) },
      { ...base, gate },
      { ...base, approval: gate },
      // A real capability for another scope, or an unknown scope, is refused.
      { ...base, approval: await approvalFrom(scopedGate({ scope: 'mvp_c_refunds' })) },
      {
        ...base,
        scope: 'invented',
        approval: await approvalFrom(scopedGate({ scope: 'invented' })),
      },
      { ...base, scope: '', approval: real },
    ];
    for (const o of bad) {
      const p = (createApprovedSandboxTransport as (x: unknown) => Promise<Transport>)(o);
      await expect(p).rejects.toBeInstanceOf(SandboxSealedError);
      await expect(p).rejects.toMatchObject({ name: 'SandboxSealedError' });
    }
    expect(() => mintApprovalCapability({ scope: '', approval_ref: 'x', gate })).toThrow();
    expect(() => mintApprovalCapability({ scope: SCOPE, approval_ref: '', gate })).toThrow();
    expect(wire.requests).toHaveLength(0);
  });

  it('a gate with an active approval for the scope yields a sandbox transport', async () => {
    const { t } = await build();
    expect(t.kind).toBe('sandbox');
  });
});

describe('exact bytes on the wire (OpenAPI shapes)', () => {
  const ok = (r: OutboundRequest) => r;
  const cases: {
    name: string;
    r: OutboundRequest;
    wire: {
      method: 'GET' | 'POST';
      url: string;
      headers: Record<string, string>;
      body: string | null;
    };
  }[] = [
    {
      name: 'oauth_token',
      r: ok(
        req('oauth_token', '/v1/oauth2/token', {
          headers: {
            Authorization: 'Basic ZmFrZTpmYWtl',
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: 'grant_type=client_credentials',
        }),
      ),
      wire: {
        method: 'POST',
        url: `${BASE}/v1/oauth2/token`,
        headers: {
          authorization: 'Basic ZmFrZTpmYWtl',
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
      },
    },
    {
      name: 'create_order',
      r: req('create_order', '/v2/checkout/orders', {
        headers: {
          Authorization: 'Bearer fake-token',
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          'PayPal-Request-Id': 'umsC-req-1',
        },
        body: orderBody('5.00'),
        amount_minor: 500,
      }),
      wire: {
        method: 'POST',
        url: `${BASE}/v2/checkout/orders`,
        headers: {
          authorization: 'Bearer fake-token',
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'return=representation',
          'paypal-request-id': 'umsC-req-1',
        },
        body: orderBody('5.00'),
      },
    },
    {
      name: 'get_order',
      r: req('get_order', '/v2/checkout/orders/5O190127TN364715T', {
        headers: { Authorization: 'Bearer fake-token', Accept: 'application/json' },
      }),
      wire: {
        method: 'GET',
        url: `${BASE}/v2/checkout/orders/5O190127TN364715T`,
        headers: { authorization: 'Bearer fake-token', accept: 'application/json' },
        body: null,
      },
    },
    {
      name: 'capture_order',
      r: req('capture_order', `${BASE}/v2/checkout/orders/5O190127TN364715T/capture`, {
        headers: {
          Authorization: 'Bearer fake-token',
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          'PayPal-Request-Id': 'umsK-cap-1',
        },
        body: '{}',
      }),
      wire: {
        method: 'POST',
        url: `${BASE}/v2/checkout/orders/5O190127TN364715T/capture`,
        headers: {
          authorization: 'Bearer fake-token',
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'return=representation',
          'paypal-request-id': 'umsK-cap-1',
        },
        body: '{}',
      },
    },
    {
      name: 'get_capture',
      r: req('get_capture', '/v2/payments/captures/3C679366HH908993F', {
        headers: { Authorization: 'Bearer fake-token', Accept: 'application/json' },
      }),
      wire: {
        method: 'GET',
        url: `${BASE}/v2/payments/captures/3C679366HH908993F`,
        headers: { authorization: 'Bearer fake-token', accept: 'application/json' },
        body: null,
      },
    },
    {
      name: 'refund_capture',
      r: req('refund_capture', '/v2/payments/captures/3C679366HH908993F/refund', {
        headers: {
          Authorization: 'Bearer fake-token',
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          'PayPal-Request-Id': 'umsR-ref-1',
        },
        body: '{"amount":{"value":"5.00","currency_code":"USD"}}',
        amount_minor: 500,
      }),
      wire: {
        method: 'POST',
        url: `${BASE}/v2/payments/captures/3C679366HH908993F/refund`,
        headers: {
          authorization: 'Bearer fake-token',
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'return=representation',
          'paypal-request-id': 'umsR-ref-1',
        },
        body: '{"amount":{"value":"5.00","currency_code":"USD"}}',
      },
    },
  ];

  for (const c of cases) {
    it(`${c.name}: wire sees exactly the normalised url, headers, body and the 10 s timeout`, async () => {
      const scope = c.name === 'refund_capture' ? 'mvp_c_refunds' : SCOPE;
      const { t, wire, gate } = await build({ scope });
      const res = await t.send(c.r);
      expect(res.kind).toBe('response');
      expect(wire.requests).toEqual([{ ...c.wire, timeout_ms: 10_000 }]);
      expect(gate.checks).toEqual([
        {
          operation: c.r.operation,
          amount_minor: c.r.amount_minor,
          scope,
          approval_ref: 'appr-test',
        },
      ]);
    });
  }

  it('sends to the guard-normalised href, not the caller spelling', async () => {
    const { t, wire } = await build();
    await t.send(
      req('get_order', `HTTPS://${SANDBOX_HOST.toUpperCase()}/v2/checkout/orders/ABC123`),
    );
    expect(wire.requests[0]?.url).toBe(`${BASE}/v2/checkout/orders/ABC123`);
  });
});

describe('request headers', () => {
  const send = async (headers: Record<string, string>, o: Partial<OutboundRequest> = {}) => {
    const b = await build();
    const res = await b.t.send(req('get_order', '/v2/checkout/orders/ABC123', { headers, ...o }));
    return { ...b, res };
  };

  it('drops Host and X-HTTP-Method-Override in every spelling, and every unknown header', async () => {
    const { wire } = await send({
      Authorization: 'Bearer t',
      Host: 'evil.example',
      host: 'evil.example',
      'X-HTTP-Method-Override': 'DELETE',
      'x-http-method-override': 'PUT',
      'X-Forwarded-For': '1.2.3.4',
      Cookie: 'a=b',
      'Proxy-Authorization': 'Basic x',
      'Transfer-Encoding': 'chunked',
      'Content-Length': '99999',
      Connection: 'keep-alive',
      'X-Anything': '1',
      'PayPal-Auth-Assertion': 'a.b.',
    });
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]?.headers).toEqual({ authorization: 'Bearer t' });
  });

  it('refuses (egress) a header value with CR, LF or NUL, and a header name that is not a token', async () => {
    for (const h of [
      { Authorization: 'Bearer t\r\nX-Evil: 1' },
      { Authorization: 'Bearer t\nX' },
      { Authorization: 'Bearer \u0000t' },
      { Accept: 'application/json\u0085' },
      { 'Accept\r\nX-Evil': 'x' },
    ]) {
      const { res, wire } = await send(h);
      expect(res).toEqual({ kind: 'blocked', by: 'egress' });
      expect(wire.requests).toHaveLength(0);
    }
  });

  it('refuses two spellings of one allowed header (ambiguous)', async () => {
    const { res, wire } = await send({ Authorization: 'Bearer a', authorization: 'Bearer b' });
    expect(res).toEqual({ kind: 'blocked', by: 'egress' });
    expect(wire.requests).toHaveLength(0);
  });

  it('refuses a GET with a body and a body over 64 KiB', async () => {
    const a = await send({}, { body: '{}' });
    expect(a.res).toEqual({ kind: 'blocked', by: 'egress' });
    const b = await build();
    const big = 'x'.repeat(64 * 1024 + 1);
    expect(await b.t.send(req('create_order', '/v2/checkout/orders', { body: big }))).toEqual({
      kind: 'blocked',
      by: 'egress',
    });
    const edge = 'x'.repeat(64 * 1024);
    expect(
      (await b.t.send(req('capture_order', '/v2/checkout/orders/ABC123/capture', { body: edge })))
        .kind,
    ).toBe('response');
    expect(b.wire.requests).toHaveLength(1);
  });

  it('refuses a POST without a body string', async () => {
    const b = await build();
    const r = await b.t.send(createOrder({ body: null }));
    expect(r).toEqual({ kind: 'blocked', by: 'egress' });
    expect(b.wire.requests).toHaveLength(0);
  });
});

describe('gate', () => {
  it('guard runs before the gate; a refused request never consults the gate', async () => {
    const { t, gate, wire } = await build();
    expect(await t.send(req('get_order', 'https://evil.example/v2/checkout/orders/A'))).toEqual({
      kind: 'blocked',
      by: 'egress',
    });
    expect(gate.checks).toHaveLength(0);
    expect(wire.requests).toHaveLength(0);
  });

  for (const by of ['connect_off', 'kill_switch', 'no_approval', 'budget'] as const) {
    it(`gate verdict ${by} returns blocked ${by} and the wire is never touched`, async () => {
      const gate = scopedGate({ verdict: () => ({ allowed: false, by }) });
      const { t, wire } = await build({ gate });
      expect(await t.send(req('get_order', '/v2/checkout/orders/ABC123'))).toEqual({
        kind: 'blocked',
        by,
      });
      expect(gate.checks).toHaveLength(1);
      expect(wire.requests).toHaveLength(0);
    });
  }

  it('a gate that throws, hangs up with garbage or allows without an approval ref blocks (fail closed)', async () => {
    const verdicts: (() => unknown)[] = [
      () => {
        throw new Error('db down');
      },
      () => undefined,
      () => null,
      () => ({ allowed: true }),
      () => ({ allowed: true, approval_ref: '' }),
      () => ({ allowed: 'yes', approval_ref: 'x' }),
      () => ({ allowed: false, by: 'whatever' }),
      () => ({ allowed: true, approval_ref: 'x', extra: 1 }),
    ];
    for (const v of verdicts) {
      const gate = scopedGate({ verdict: v });
      const { t, wire } = await build({ gate });
      const res = await t.send(req('get_order', '/v2/checkout/orders/ABC123'));
      expect(res.kind).toBe('blocked');
      expect(wire.requests).toHaveLength(0);
    }
  });

  it('consults the gate exactly once per send, with the operation and the amount', async () => {
    const { t, gate } = await build();
    await t.send(createOrder({ body: orderBody('12.34'), amount_minor: 1234 }));
    await t.send(req('get_order', '/v2/checkout/orders/ABC123'));
    const bound = { scope: SCOPE, approval_ref: 'appr-test' };
    expect(gate.checks).toEqual([
      { operation: 'create_order', amount_minor: 1234, ...bound },
      { operation: 'get_order', amount_minor: null, ...bound },
    ]);
  });
});

describe('no retries, error mapping, response handling', () => {
  const failures: [string, WireResult, unknown][] = [
    ['timeout', { kind: 'error', error: 'timeout' }, { kind: 'timeout' }],
    ['dns', { kind: 'error', error: 'dns' }, { kind: 'network_error', code: 'dns' }],
    ['connect', { kind: 'error', error: 'connect' }, { kind: 'network_error', code: 'connect' }],
    ['tls', { kind: 'error', error: 'tls' }, { kind: 'network_error', code: 'tls' }],
    ['reset', { kind: 'error', error: 'reset' }, { kind: 'network_error', code: 'reset' }],
    ['redirect', { kind: 'error', error: 'redirect' }, { kind: 'network_error', code: 'redirect' }],
    [
      'too_large',
      { kind: 'error', error: 'too_large' },
      { kind: 'network_error', code: 'response_too_large' },
    ],
    ['aborted', { kind: 'error', error: 'aborted' }, { kind: 'network_error', code: 'aborted' }],
    ['other', { kind: 'error', error: 'other' }, { kind: 'network_error', code: 'other' }],
  ];
  for (const [name, wireResult, expected] of failures) {
    it(`wire error ${name} maps to ${JSON.stringify(expected)}; a POST is sent once and a GET is sent once`, async () => {
      const wire = fakeWire(() => wireResult);
      const { t } = await build({ wire });
      expect(await t.send(createOrder())).toEqual(expected);
      expect(wire.requests).toHaveLength(1);
      expect(await t.send(req('get_order', '/v2/checkout/orders/ABC123'))).toEqual(expected);
      expect(wire.requests).toHaveLength(2);
    });
  }

  it('a wire that throws or returns garbage is network_error wire_failure, never an exception', async () => {
    for (const h of [
      () => {
        throw new Error('secret-ish detail');
      },
      () => Promise.reject(new Error('boom')),
      () => undefined as unknown as WireResult,
      () => ({ kind: 'response', status: 'x', headers: {}, body: '' }) as unknown as WireResult,
      () => ({ kind: 'response', status: 200, headers: {}, body: 5 }) as unknown as WireResult,
      () => ({ kind: 'error', error: 'novel' }) as unknown as WireResult,
    ]) {
      const wire = fakeWire(h);
      const { t } = await build({ wire });
      expect(await t.send(createOrder())).toEqual({
        kind: 'network_error',
        code: 'wire_failure',
      });
      expect(wire.requests).toHaveLength(1);
    }
  });

  it('5xx and 429 are responses, not retried', async () => {
    for (const status of [500, 502, 429]) {
      const wire = fakeWire(() => ({ kind: 'response', status, headers: {}, body: '{}' }));
      const { t } = await build({ wire });
      const r = await t.send(req('capture_order', '/v2/checkout/orders/ABC123/capture'));
      expect(r).toMatchObject({ kind: 'response', status });
      expect(wire.requests).toHaveLength(1);
    }
  });

  it('a 3xx is never followed: network_error redirect', async () => {
    for (const status of [300, 301, 302, 307, 308]) {
      const wire = fakeWire(() => ({
        kind: 'response',
        status,
        headers: { location: 'https://evil.example/' },
        body: '',
      }));
      const { t } = await build({ wire });
      expect(await t.send(req('get_order', '/v2/checkout/orders/ABC123'))).toEqual({
        kind: 'network_error',
        code: 'redirect',
      });
      expect(wire.requests).toHaveLength(1);
    }
    // 304 and 200 boundaries
    const w2 = fakeWire(() => ({ kind: 'response', status: 399, headers: {}, body: '' }));
    expect(
      (await (await build({ wire: w2 })).t.send(req('get_order', '/v2/checkout/orders/A'))).kind,
    ).toBe('network_error');
    const w3 = fakeWire(() => ({ kind: 'response', status: 299, headers: {}, body: '' }));
    expect(
      (await (await build({ wire: w3 })).t.send(req('get_order', '/v2/checkout/orders/A'))).kind,
    ).toBe('response');
    const w4 = fakeWire(() => ({ kind: 'response', status: 400, headers: {}, body: '' }));
    expect(
      (await (await build({ wire: w4 })).t.send(req('get_order', '/v2/checkout/orders/A'))).kind,
    ).toBe('response');
  });

  it('a response body over 1 MiB is network_error response_too_large, exactly 1 MiB is fine', async () => {
    const mk = (n: number) =>
      fakeWire(() => ({ kind: 'response', status: 200, headers: {}, body: 'x'.repeat(n) }));
    const big = await build({ wire: mk(1024 * 1024 + 1) });
    expect(await big.t.send(req('get_order', '/v2/checkout/orders/A'))).toEqual({
      kind: 'network_error',
      code: 'response_too_large',
    });
    const edge = await build({ wire: mk(1024 * 1024) });
    expect((await edge.t.send(req('get_order', '/v2/checkout/orders/A'))).kind).toBe('response');
  });

  it('returns status, body, headers without set-cookie, and duration from the injected clock', async () => {
    let now = 1_000;
    const clock = { now: () => new Date((now += 7)) };
    const wire = fakeWire(() => ({
      kind: 'response',
      status: 201,
      headers: { 'PayPal-Debug-Id': 'abc123', 'Set-Cookie': 'a=b', 'set-cookie': 'c=d', Etag: 'e' },
      body: '{"id":"X"}',
    }));
    const { t } = await build({ wire, clock });
    const r = await t.send(createOrder());
    expect(r).toEqual({
      kind: 'response',
      status: 201,
      headers: { 'PayPal-Debug-Id': 'abc123', Etag: 'e' },
      body: '{"id":"X"}',
      duration_ms: 7,
    });
  });
});

describe('records and logs never hold credentials', () => {
  it('redacts authorization in calls() and in every log line, and keeps no response body', async () => {
    const wire = fakeWire(() => ({
      kind: 'response',
      status: 200,
      headers: {},
      body: '{"access_token":"RESPONSE-TOKEN-VALUE"}',
    }));
    const { t, log } = await build({ wire });
    await t.send(
      req('oauth_token', '/v1/oauth2/token', {
        headers: { Authorization: 'Basic QkFTSUMtU0VDUkVU', 'Content-Type': 'x/y', Cookie: 'c=1' },
        body: 'grant_type=client_credentials',
      }),
    );
    await t.send(
      req('get_order', '/v2/checkout/orders/ABC123', {
        headers: { Authorization: 'Bearer BEARER-SECRET-VALUE' },
      }),
    );
    // a refused request is recorded and redacted as well
    await t.send(
      req('get_order', 'https://evil.example/x', {
        headers: { Authorization: 'Bearer EVIL-SECRET' },
      }),
    );
    const calls = t.calls();
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.outcome)).toEqual(['response', 'response', 'blocked:egress']);
    expect(calls[0]?.headers).toEqual({ authorization: '[redacted]', 'content-type': 'x/y' });
    expect(calls[1]?.url).toBe(`${BASE}/v2/checkout/orders/ABC123`);
    expect(calls[2]?.url).toBeNull();
    expect(log.events.length).toBeGreaterThanOrEqual(3);
    const all = JSON.stringify([calls, log.events]);
    for (const secret of [
      'QkFTSUMtU0VDUkVU',
      'BEARER-SECRET-VALUE',
      'EVIL-SECRET',
      'RESPONSE-TOKEN-VALUE',
      'c=1',
    ]) {
      expect(all).not.toContain(secret);
    }
    // mutating the returned copy does not change the record
    (calls[0]?.headers as Record<string, string>).authorization = 'tampered';
    expect(t.calls()[0]?.headers.authorization).toBe('[redacted]');
  });
});

describe('snapshot: the request is read once', () => {
  it('a request whose fields change between reads cannot swap the validated target', async () => {
    const { t, wire } = await build();
    let reads = 0;
    const evil = {
      operation: 'get_order',
      get method() {
        return reads++ === 0 ? 'GET' : 'POST';
      },
      get path() {
        return reads++ < 3 ? '/v2/checkout/orders/ABC123' : 'https://evil.example/x';
      },
      headers: { Authorization: 'Bearer t' },
      body: null,
      order_ref: null,
      amount_minor: null,
      scenario: null,
    } as unknown as OutboundRequest;
    const res = await t.send(evil);
    if (res.kind === 'response') {
      expect(wire.requests[0]?.url).toBe(`${BASE}/v2/checkout/orders/ABC123`);
      expect(wire.requests[0]?.method).toBe('GET');
    } else {
      expect(wire.requests).toHaveLength(0);
    }
  });

  it('a request that is not an OutboundRequest (extra field, wrong types, null) is blocked egress', async () => {
    const { t, wire, gate } = await build();
    for (const r of [
      null,
      undefined,
      'x',
      { ...req('get_order', '/v2/checkout/orders/A'), extra: 1 },
      { ...req('get_order', '/v2/checkout/orders/A'), headers: { a: 1 } },
      { ...req('get_order', '/v2/checkout/orders/A'), amount_minor: -5 },
    ]) {
      expect(await t.send(r as unknown as OutboundRequest)).toEqual({
        kind: 'blocked',
        by: 'egress',
      });
    }
    expect(wire.requests).toHaveLength(0);
    expect(gate.checks).toHaveLength(0);
  });
});
