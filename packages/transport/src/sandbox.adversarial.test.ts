import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApprovedSandboxTransport } from './sandbox';
import { createHttpsWire } from './wire-https';
import {
  LIVE_HOST,
  approvalFrom,
  SANDBOX_HOST,
  fakeWire,
  fixedClock,
  memoryLogger,
  netSpies,
  req,
  scopedGate,
} from './test-support';
import type { OutboundRequest, PayPalOperation } from '@umsbx/contracts';

// B-L1 review bar: nothing that the egress guard refuses may reach the Wire, and nothing at all
// may open a connection in this package's tests.
let spies: ReturnType<typeof netSpies>;
beforeEach(() => {
  spies = netSpies();
});
afterEach(() => {
  spies.assertZero();
  spies.spies['global fetch'].mockRestore();
});

async function build() {
  const wire = fakeWire();
  // The wide scope on purpose: these tests probe the egress guard, not the scope's operation list.
  const gate = scopedGate({ scope: 'mvp_c_refunds' });
  const t = await createApprovedSandboxTransport({
    approval: await approvalFrom(gate),
    scope: 'mvp_c_refunds',
    wire,
    clock: fixedClock(),
    log: memoryLogger(),
  });
  return { t, wire, gate };
}

const H = SANDBOX_HOST;
const attempts: [string, OutboundRequest][] = [
  ['live host', req('get_order', `https://${LIVE_HOST}/v2/checkout/orders/ABC123`)],
  ['http', req('get_order', `http://${H}/v2/checkout/orders/ABC123`)],
  ['port 8443', req('get_order', `https://${H}:8443/v2/checkout/orders/ABC123`)],
  ['userinfo', req('get_order', `https://${H}@evil.example/v2/checkout/orders/ABC123`)],
  ['userinfo2', req('get_order', `https://user:pw@${H}/v2/checkout/orders/ABC123`)],
  ['scheme-relative', req('get_order', '//evil.example/v2/checkout/orders/ABC123')],
  ['backslash', req('get_order', `https://${H}\\@evil.example/v2/checkout/orders/ABC123`)],
  ['query', req('get_order', '/v2/checkout/orders/ABC123?x=1')],
  ['fragment', req('get_order', '/v2/checkout/orders/ABC123#x')],
  ['percent', req('get_order', '/v2/checkout/orders/%41BC123')],
  ['dot segment', req('get_order', '/v2/checkout/orders/../orders/ABC123')],
  ['trailing slash', req('get_order', '/v2/checkout/orders/ABC123/')],
  ['lowercase id', req('get_order', '/v2/checkout/orders/abc123')],
  ['id too long', req('get_order', `/v2/checkout/orders/${'A'.repeat(37)}`)],
  ['unknown path', req('get_order', '/v1/payments/payouts')],
  ['payouts', req('create_order', '/v1/payments/payouts')],
  ['wrong method for op', req('get_order', '/v2/checkout/orders/ABC123', { method: 'POST' })],
  ['wrong op for path', req('capture_order', '/v2/checkout/orders/ABC123')],
  ['space', req('get_order', '/v2/checkout/orders/ABC 123')],
  ['newline', req('get_order', '/v2/checkout/orders/ABC123\nHost: evil.example')],
  ['non-ascii', req('get_order', '/v2/checkout/orders/ABCé')],
  ['empty', req('get_order', '')],
  [
    'cert on evil host',
    req('fetch_webhook_cert', 'https://evil.example/v1/notifications/certs/C1'),
  ],
  [
    'cert lookalike host',
    req(
      'fetch_webhook_cert',
      `https://api.sandbox.paypal.com.evil.example/v1/notifications/certs/C1`,
    ),
  ],
  ['cert relative', req('fetch_webhook_cert', '/v1/notifications/certs/C1')],
  ['cert wrong prefix', req('fetch_webhook_cert', 'https://api.sandbox.paypal.com/v1/other/C1')],
  ['proto operation', req('__proto__' as PayPalOperation, '/v2/checkout/orders')],
  ['constructor operation', req('constructor' as PayPalOperation, '/v2/checkout/orders')],
  ['toString operation', req('toString' as PayPalOperation, '/v2/checkout/orders')],
];

describe('guard bypass attempts never reach the wire or the gate', () => {
  for (const [name, r] of attempts) {
    it(`refuses: ${name}`, async () => {
      const { t, wire, gate } = await build();
      expect(await t.send(r)).toEqual({ kind: 'blocked', by: 'egress' });
      expect(wire.requests).toHaveLength(0);
      expect(gate.checks).toHaveLength(0);
    });
  }

  it('an explicit :443 is normalised away: the wire gets the href without a port', async () => {
    const { t, wire } = await build();
    await t.send(req('get_order', `https://${H}:443/v2/checkout/orders/ABC123`));
    expect(wire.requests[0]?.url).toBe(`https://${H}/v2/checkout/orders/ABC123`);
  });

  it('the allowed sandbox cert fetch passes on a sandbox cert host only', async () => {
    const { t, wire } = await build();
    const url = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1';
    const r = await t.send(req('fetch_webhook_cert', url, { method: 'GET', body: null }));
    expect(r.kind).toBe('response');
    expect(wire.requests[0]?.url).toBe(url);
  });

  it('a Host or method-override header on an allowed request is dropped, not forwarded', async () => {
    const { t, wire } = await build();
    await t.send(
      req('get_order', '/v2/checkout/orders/ABC123', {
        headers: {
          Host: 'evil.example',
          'X-HTTP-Method-Override': 'DELETE',
          Authorization: 'Bearer t',
        },
      }),
    );
    expect(Object.keys(wire.requests[0]?.headers ?? {})).toEqual(['authorization']);
  });
});

describe('no real network in this package', () => {
  it('constructing the production Wire, and a full sealed + approved run, opens nothing', async () => {
    const prod = createHttpsWire();
    expect(typeof prod.request).toBe('function');
    const { t } = await build();
    await t.send(req('get_order', '/v2/checkout/orders/ABC123'));
    expect(spies.counts()).toEqual(Object.fromEntries(Object.keys(spies.spies).map((k) => [k, 0])));
    const open = process
      .getActiveResourcesInfo()
      .filter((x) => x === 'TCPSocketWrap' || x === 'TCPConnectWrap' || x === 'TLSWrap');
    expect(open).toEqual([]);
  });
});
