import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanProcess, fakeRequest, loadHttpsWire, unloadHttpsWire } from './https-fake';
import { CERT_HOST, SANDBOX_HOST } from './test-support';
import { makeHttpsWire } from './wire-https';
import type { WireRequest } from './wire';

// BU-1 contract: the exact options object the Wire hands to the request function. No socket is
// opened; the request function is an in-memory fake.
const ALLOWED = ['accept', 'authorization', 'content-type', 'paypal-request-id', 'prefer'];
const lookup = (() => undefined) as unknown as typeof import('node:dns').lookup;
const wireReq = (over: Partial<WireRequest> = {}): WireRequest => ({
  method: 'GET',
  url: `https://${SANDBOX_HOST}/v2/checkout/orders/ABC123`,
  headers: { authorization: 'Bearer placeholder', accept: 'application/json', cookie: 'a=b' },
  body: null,
  timeout_ms: 10_000,
  ...over,
});

describe('the options handed to the request function (makeHttpsWire)', () => {
  const agent = new https.Agent({ keepAlive: false });
  const make = () => {
    const f = fakeRequest();
    const wire = makeHttpsWire({
      request: f.request as unknown as typeof https.request,
      agent,
      lookup,
      builtinsIntact: () => true,
      envOverridden: () => false,
    });
    return { wire, calls: f.calls };
  };

  it('carries exactly the pinned TLS, DNS and agent options, and nothing else', async () => {
    const { wire, calls } = make();
    await wire.request(wireReq());
    expect(calls[0]?.options).toStrictEqual({
      protocol: 'https:',
      hostname: SANDBOX_HOST,
      port: 443,
      path: '/v2/checkout/orders/ABC123',
      method: 'GET',
      headers: { authorization: 'Bearer placeholder', accept: 'application/json' },
      agent,
      lookup,
      servername: SANDBOX_HOST,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      insecureHTTPParser: false,
    });
  });
  it('rejectUnauthorized is the boolean true and minVersion is TLSv1.2, for every request', async () => {
    const { wire, calls } = make();
    await wire.request(wireReq());
    await wire.request(wireReq({ method: 'POST', body: '{}' }));
    for (const c of calls) {
      expect(c.options['rejectUnauthorized']).toBe(true);
      expect(c.options['minVersion']).toBe('TLSv1.2');
      expect(c.options['insecureHTTPParser']).toBe(false);
      expect(c.options['agent']).toBe(agent);
      expect(c.options['lookup']).toBe(lookup);
    }
  });
  it('servername is the host being connected to, also for the certificate host', async () => {
    const { wire, calls } = make();
    await wire.request(wireReq({ url: `https://${CERT_HOST}/v1/notifications/certs/CERT-1` }));
    expect(calls[0]?.options['hostname']).toBe(CERT_HOST);
    expect(calls[0]?.options['servername']).toBe(CERT_HOST);
    expect(calls[0]?.options['path']).toBe('/v1/notifications/certs/CERT-1');
  });
  it('only allow-listed headers are in the options, whatever the caller offered', async () => {
    const { wire, calls } = make();
    await wire.request(
      wireReq({
        headers: {
          authorization: 'a',
          accept: 'b',
          'content-type': 'c',
          prefer: 'd',
          'paypal-request-id': 'e',
          host: 'x',
          cookie: 'x',
          connection: 'x',
          'content-length': '1',
          'transfer-encoding': 'x',
          'x-http-method-override': 'x',
          'accept-encoding': 'x',
          'proxy-authorization': 'x',
        },
      }),
    );
    expect(Object.keys(calls[0]?.options['headers'] as object).sort()).toEqual(ALLOWED);
  });
  it('the request function is called once per Wire call, with the options and a response callback', async () => {
    let args: unknown[] = [];
    const wire = makeHttpsWire({
      request: ((...a: unknown[]) => {
        args = a;
        return fakeRequest().request(a[0] as Record<string, unknown>, a[1] as never);
      }) as unknown as typeof https.request,
      agent,
      lookup,
      builtinsIntact: () => true,
      envOverridden: () => false,
    });
    await wire.request(wireReq());
    expect(args).toHaveLength(2);
    expect(typeof args[0]).toBe('object');
    expect(typeof args[1]).toBe('function');
  });
});

describe('the Wire built by createHttpsWire (against fake node:https, node:tls, node:dns)', () => {
  let restoreArgv: () => void;
  let loaded: Awaited<ReturnType<typeof loadHttpsWire>>;
  beforeEach(async () => {
    restoreArgv = cleanProcess();
    loaded = await loadHttpsWire();
  });
  afterEach(() => {
    restoreArgv();
    vi.unstubAllEnvs();
    unloadHttpsWire();
  });

  it('uses the request function, lookup and an agent of its own, all captured when the module loaded', async () => {
    await loaded.createHttpsWire().request(wireReq());
    const o = loaded.world.calls[0]?.options as Record<string, unknown>;
    expect(o['lookup']).toBe(loaded.world.lookup);
    const agent = o['agent'] as https.Agent;
    expect(agent).toBeInstanceOf(https.Agent);
    expect(agent).not.toBe(https.globalAgent);
    expect(o['rejectUnauthorized']).toBe(true);
    expect(o['minVersion']).toBe('TLSv1.2');
    expect(o['servername']).toBe(SANDBOX_HOST);
  });
  it('the agent keeps no connections alive and caches no TLS sessions', async () => {
    await loaded.createHttpsWire().request(wireReq());
    const agent = loaded.world.calls[0]?.options['agent'] as https.Agent & {
      keepAlive: boolean;
      options: { keepAlive?: boolean; maxCachedSessions?: number };
    };
    expect(agent.keepAlive).toBe(false);
    expect(agent.options.keepAlive).toBe(false);
    expect(agent.options.maxCachedSessions).toBe(0);
  });
  it('the agent opens its connections with the tls.connect captured at load', async () => {
    await loaded.createHttpsWire().request(wireReq());
    const agent = loaded.world.calls[0]?.options['agent'] as unknown as {
      createConnection(o: object, cb?: () => void): unknown;
    };
    const opts = { host: SANDBOX_HOST, port: 443, servername: SANDBOX_HOST };
    agent.createConnection(opts, () => undefined);
    expect(loaded.world.connect).toHaveBeenCalledTimes(1);
    expect(loaded.world.connect.mock.calls[0]).toContainEqual(opts);
  });
  it('two Wires do not share an agent (each owns its connections)', async () => {
    const a = loaded.createHttpsWire();
    const b = loaded.createHttpsWire();
    await a.request(wireReq());
    await b.request(wireReq());
    const [x, y] = loaded.world.calls.map((c) => c.options['agent']);
    expect(x).not.toBe(y);
  });
  it('building the Wire is free of I/O: no request, lookup or connect until a request is made', () => {
    loaded.createHttpsWire();
    expect(loaded.world.calls).toHaveLength(0);
    expect(loaded.world.lookup).not.toHaveBeenCalled();
    expect(loaded.world.connect).not.toHaveBeenCalled();
  });
});
