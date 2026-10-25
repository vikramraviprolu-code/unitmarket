// MVP-C offline gate, adversarial part: the whole C run opens no socket. The four C test files are
// loaded from here (their tests register in this file and run in its module graph) with every way to
// open a connection or resolve a name replaced by a function that records the call and throws:
//   - module exports: net.connect and createConnection, tls.connect, http(s).request and get,
//     http2.connect, dns lookup/resolve*/reverse, node:dns/promises, and fetch;
//   - guards on the shared classes that module-export replacement misses (CO-Gb, gate review M1):
//     net.Socket.prototype.connect, http.Agent and https.Agent createConnection, dns.promises;
//   - a subscription to the diagnostics channel `net.client.socket`, which Node publishes for every
//     client socket whatever route created it (the backstop for a shape nobody listed).
// The last test reads the record: it must be empty. The canary tests before the C tests check the
// harness itself, so an empty record means "never called" and not "never watched": a helper module
// (c-net-probe.ts) must see the patched node:net, and each bypass shape must be recorded. The C-11
// restart test (scripts/c11-restart.integration.test.ts) spawns children; each child traces the same
// shapes inside its own process, sends every attempt as it happens and refuses it.
// netSpies() in packages/transport/src/test-support.ts lists the same functions but is sealed to its
// package (SEAL2 lint), so the list is rebuilt here.
import dc from 'node:diagnostics_channel';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { bypassShapes, netViews, openRaw } from './c-net-probe';
import type { RawNet } from './c-net-probe';

vi.mock('server-only', () => ({}));

const { trace, patch, patchDns, blocked, fetchStub, hooks } = vi.hoisted(() => {
  const trace = { calls: [] as string[] };
  const blocked =
    (label: string) =>
    (...args: unknown[]): never => {
      void args;
      trace.calls.push(label);
      throw new Error(`${label}: the C run is offline`);
    };
  type Mod = Record<string, unknown>;
  type Fn = (...a: unknown[]) => unknown;
  /** Replaces the named exports of a module; `guard` may also guard classes the module shares. */
  const patch =
    (names: string[], module: string, guard?: (actual: Mod) => void) =>
    async (importOriginal: () => Promise<unknown>) => {
      const actual = (await importOriginal()) as Mod;
      guard?.(actual);
      const patched: Mod = { ...actual };
      for (const name of names) patched[name] = blocked(`${module}.${name}`);
      return { ...patched, default: patched };
    };
  const DNS_NAMES = /^(lookup|resolve|reverse)/;
  const fnNames = (m: Mod): string[] =>
    Object.keys(m).filter((k) => DNS_NAMES.test(k) && typeof m[k] === 'function');
  // dns.promises is ONE object shared by node:dns and node:dns/promises, and by any module outside
  // this graph that reads it: guard its functions in place, once.
  let dnsPromisesGuarded = false;
  const guardDnsPromises = (p: Mod): void => {
    if (dnsPromisesGuarded) return;
    dnsPromisesGuarded = true;
    for (const k of fnNames(p))
      vi.spyOn(p as Record<string, Fn>, k).mockImplementation(blocked(`dns.promises.${k}`) as Fn);
  };
  const patchDns = {
    dns: async (importOriginal: () => Promise<unknown>) => {
      const actual = (await importOriginal()) as Mod;
      guardDnsPromises(actual['promises'] as Mod);
      const patched: Mod = { ...actual };
      for (const k of fnNames(actual)) patched[k] = blocked(`dns.${k}`);
      return { ...patched, default: patched };
    },
    promises: async (importOriginal: () => Promise<unknown>) => {
      const actual = (await importOriginal()) as Mod;
      const shared = actual['default'] as Mod;
      guardDnsPromises(shared);
      const patched: Mod = { ...actual };
      for (const k of fnNames(actual)) patched[k] = blocked(`dns/promises.${k}`);
      return { ...patched, default: shared };
    },
  };
  const fetchStub = (...a: unknown[]): Promise<never> => {
    trace.calls.push(`fetch ${String(a[0])}`);
    return Promise.reject(new Error('fetch: the C run is offline'));
  };
  // Filled by the interception (CO-Gb): the unpatched functions, and a switch that lets the
  // Socket.prototype.connect guard call through, for the channel proof only.
  const hooks = {
    raw: {} as Partial<RawNet>,
    passThrough: undefined as ((on: boolean) => void) | undefined,
  };
  const guardSocket = (actual: Mod): void => {
    const proto = (actual['Socket'] as { prototype: Record<string, Fn> }).prototype;
    const real = proto['connect'] as Fn;
    hooks.raw.socketConnect = real as RawNet['socketConnect'];
    const refuse = blocked('net.Socket.prototype.connect') as Fn;
    const spy = vi.spyOn(proto, 'connect').mockImplementation(refuse);
    hooks.passThrough = (on) => void spy.mockImplementation(on ? real : refuse);
  };
  const guardAgent =
    (label: string, remember: boolean) =>
    (actual: Mod): void => {
      const proto = (actual['Agent'] as { prototype: Record<string, Fn> }).prototype;
      if (remember) hooks.raw.agentCreateConnection = proto['createConnection'] as never;
      vi.spyOn(proto, 'createConnection').mockImplementation(blocked(label) as Fn);
    };
  const guardHttp2 = (actual: Mod): void => {
    hooks.raw.http2Connect = actual['connect'] as RawNet['http2Connect'];
  };
  return {
    trace,
    patch: Object.assign(patch, { guardSocket, guardAgent, guardHttp2 }),
    patchDns,
    blocked,
    fetchStub,
    hooks,
  };
});
vi.stubGlobal('fetch', fetchStub);
vi.mock('node:net', patch(['connect', 'createConnection'], 'net', patch.guardSocket));
vi.mock('node:tls', patch(['connect'], 'tls'));
vi.mock(
  'node:http',
  patch(
    ['request', 'get'],
    'http',
    patch.guardAgent('http.Agent.prototype.createConnection', true),
  ),
);
vi.mock(
  'node:https',
  patch(
    ['request', 'get'],
    'https',
    patch.guardAgent('https.Agent.prototype.createConnection', false),
  ),
);
vi.mock('node:http2', patch(['connect'], 'http2', patch.guardHttp2));
vi.mock('node:dns', patchDns.dns);
vi.mock('node:dns/promises', patchDns.promises);

// Node publishes `net.client.socket` for every client socket, however it was made. Whatever the
// guards above miss still lands here.
const onClientSocket = (): void => {
  trace.calls.push('net.client.socket');
};
dc.subscribe('net.client.socket', onClientSocket);

describe('C-offline interception', () => {
  it('C-offline the watch itself: a watched function records its call and throws, and fetch is stubbed to record and reject', async () => {
    const probe = blocked('probe.fn');
    expect(() => probe('x')).toThrow(/the C run is offline/);
    expect(trace.calls).toEqual(['probe.fn']);
    // the fetch stub installed for this file records and rejects (a reference is kept, so no global is called by name)
    await expect(Reflect.apply(fetchStub, undefined, ['https://example.invalid/'])).rejects.toThrow(
      /offline/,
    );
    expect(trace.calls).toEqual(['probe.fn', 'fetch https://example.invalid/']);
    trace.calls.length = 0; // nothing else has run yet: this is the first test of the file
  });
});

// CO-Gb (gate review M1). Replacing module exports misses connections opened another way, so the
// interception is also a set of guards on the classes and a subscription to the channel Node publishes
// whenever a client socket is created. These tests open each way through c-net-probe.ts (a module that
// imports the network modules as product code does) and expect the trace to record it. Nothing leaves
// the machine: each probe is refused by the guard, and the channel proof uses loopback port 1.
describe('C-offline interception, bypass shapes', () => {
  afterEach(() => {
    trace.calls.length = 0;
  });
  it('C-offline a helper module sees the patched node:net: default, named and namespace imports record and are refused', () => {
    for (const [view, open] of Object.entries(netViews)) {
      trace.calls.length = 0;
      expect(open(), view).toBe(true);
      expect(trace.calls, view).toEqual(['net.connect']);
    }
  });
  const SHAPES: [keyof typeof bypassShapes, string][] = [
    ['net.Socket.prototype.connect', 'net.Socket.prototype.connect'],
    ['dns.promises.lookup', 'dns.promises.lookup'],
    ['node:dns/promises named lookup', 'dns/promises.lookup'],
    ['node:dns/promises default lookup', 'dns.promises.lookup'],
    ['http2.connect', 'http2.connect'],
    ['http.Agent createConnection', 'http.Agent.prototype.createConnection'],
    ['https.Agent createConnection', 'https.Agent.prototype.createConnection'],
  ];
  it.each(SHAPES)(
    'C-offline bypass shape %s is recorded by the harness and refused',
    (shape, label) => {
      expect(bypassShapes[shape](), `${shape} was not refused`).toBe(true);
      expect(trace.calls).toEqual([label]);
    },
  );
  it('C-offline the net.client.socket channel records real client sockets that skip the guards (unpatched functions, closed loopback port)', async () => {
    const raw = hooks.raw;
    expect(raw.socketConnect, 'the interception keeps the unpatched Socket connect').toBeTypeOf(
      'function',
    );
    expect(raw.agentCreateConnection, 'the unpatched Agent createConnection').toBeTypeOf(
      'function',
    );
    expect(raw.http2Connect, 'the unpatched http2 connect').toBeTypeOf('function');
    expect(hooks.passThrough, 'the interception can let the Socket guard call through').toBeTypeOf(
      'function',
    );
    hooks.passThrough?.(true); // the guard on Socket.prototype.connect is lifted for this one test
    try {
      await openRaw(raw as RawNet);
    } finally {
      hooks.passThrough?.(false);
    }
    expect(trace.calls).toEqual(['net.client.socket', 'net.client.socket', 'net.client.socket']);
    // and with the guard back, the same shape is refused before any socket exists
    expect(bypassShapes['net.Socket.prototype.connect']()).toBe(true);
  });
});

// The C tests. Their top-level describe blocks register here, after the canary, and run under the
// interception above. The webhook file comes first: it replaces the certificate pin accessor.
await import('./c02-c05-webhooks.integration.test');
await import('./c06-c07-refunds.integration.test');
await import('./c08-c09-operator-headers.integration.test');
await import('./c12-race.integration.test');

describe('C-offline result', () => {
  afterAll(() => {
    dc.unsubscribe('net.client.socket', onClientSocket);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('C-offline zero net.connect, Socket.connect, tls.connect, http(s).request, http2.connect, dns (callback and promises) and fetch calls, and no client socket on the channel, across the whole C run', () => {
    expect(trace.calls).toEqual([]);
  });
});
