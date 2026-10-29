// MVP-D offline gate, adversarial part: the whole D run opens no socket. The four D test files are
// loaded from here (their tests register in this file and run in its module graph) with every way to
// open a connection or resolve a name replaced by a function that records the call and throws:
//   - module exports: net.connect and createConnection, tls.connect, http(s).request and get,
//     http2.connect, dns lookup/resolve*/reverse, node:dns/promises, and fetch;
//   - guards on the shared classes that module-export replacement misses: net.Socket.prototype.connect,
//     http.Agent and https.Agent createConnection, dns.promises;
//   - a subscription to the diagnostics channel `net.client.socket`, which Node publishes for every
//     client socket whatever route created it (the backstop for a shape nobody listed).
// The last test reads the record: it must be empty. The canary tests before the D tests check the
// harness itself, so an empty record means "never called" and not "never watched". The harness and the
// canary probes (tests/mvp-c/c-net-probe.ts) are those of the MVP-C offline gate (CO-G, CO-Gb); the
// harness is rebuilt here because vi.mock and vi.hoisted are file-local. Nothing here, and nothing in
// the D files, contacts PayPal or any network. SOP 16 (uploads) is checked at the end: the app has no
// upload route, so it is not applicable to MVP-D.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dc from 'node:diagnostics_channel';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { bypassShapes, netViews, openRaw, viaSharedDns } from '../mvp-c/c-net-probe';
import type { RawNet } from '../mvp-c/c-net-probe';

vi.mock('server-only', () => ({}));

const { trace, patch, patchDns, blocked, fetchStub, hooks } = vi.hoisted(() => {
  const trace = { calls: [] as string[] };
  const blocked =
    (label: string) =>
    (...args: unknown[]): never => {
      void args;
      trace.calls.push(label);
      throw new Error(`${label}: the D run is offline`);
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
      hooks.sharedDns = actual['default'];
      // The shared module object and the Resolver classes are reachable without this mock
      // (require('node:dns'), process.getBuiltinModule, new Resolver()): guard them in place too.
      const shared = actual['default'] as Mod;
      for (const k of fnNames(shared))
        vi.spyOn(shared as Record<string, Fn>, k).mockImplementation(blocked(`dns.${k}`) as Fn);
      for (const R of [shared['Resolver'], (shared['promises'] as Mod)['Resolver']]) {
        const proto = (R as { prototype: Record<string, Fn> }).prototype;
        for (const k of Object.getOwnPropertyNames(proto).filter((n) => DNS_NAMES.test(n)))
          vi.spyOn(proto, k).mockImplementation(blocked(`dns.Resolver.${k}`) as Fn);
      }
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
    return Promise.reject(new Error('fetch: the D run is offline'));
  };
  // Filled by the interception (CO-Gb): the unpatched functions, and a switch that lets the
  // Socket.prototype.connect guard call through, for the channel proof only.
  const hooks = {
    raw: {} as Partial<RawNet>,
    passThrough: undefined as ((on: boolean) => void) | undefined,
    // the real shared node:dns object, as require('node:dns') hands it out
    sharedDns: undefined as unknown,
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

describe('D-offline interception', () => {
  it('D-offline the watch itself: a watched function records its call and throws, and fetch is stubbed to record and reject', async () => {
    const probe = blocked('probe.fn');
    expect(() => probe('x')).toThrow(/the D run is offline/);
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
// whenever a client socket is created. These tests open each way through tests/mvp-c/c-net-probe.ts (a module that
// imports the network modules as product code does) and expect the trace to record it. Nothing leaves
// the machine: each probe is refused by the guard, and the channel proof uses loopback port 1.
describe('D-offline interception, bypass shapes', () => {
  afterEach(() => {
    trace.calls.length = 0;
  });
  it('D-offline a helper module sees the patched node:net: default, named and namespace imports record and are refused', () => {
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
    ['dns.Resolver resolve4', 'dns.Resolver.resolve4'],
    ['dns.promises.Resolver resolve4', 'dns.Resolver.resolve4'],
    ['http2.connect', 'http2.connect'],
    ['http.Agent createConnection', 'http.Agent.prototype.createConnection'],
    ['https.Agent createConnection', 'https.Agent.prototype.createConnection'],
  ];
  it.each(SHAPES)(
    'D-offline bypass shape %s is recorded by the harness and refused',
    (shape, label) => {
      expect(bypassShapes[shape](), `${shape} was not refused`).toBe(true);
      expect(trace.calls).toEqual([label]);
    },
  );
  it('D-offline the shared node:dns object itself is guarded: lookup called on it through the CommonJS loader or getBuiltinModule is recorded and refused', () => {
    expect(hooks.sharedDns, 'the interception keeps the shared node:dns object').toBeDefined();
    expect(viaSharedDns(hooks.sharedDns)).toBe(true);
    expect(trace.calls).toEqual(['dns.lookup']);
  });
  it('D-offline the net.client.socket channel records real client sockets that skip the guards (unpatched functions, closed loopback port)', async () => {
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

// The D tests. Their top-level describe blocks register here, after the canary, and run under the
// interception above.
await import('./d01-d03-composite.integration.test');
await import('./d04-d05-gates-match.integration.test');
await import('./d06-d07-ledger-currency.integration.test');
await import('./continuation.integration.test');

describe('D-offline SOP 16', () => {
  it('D-offline SOP 16 not applicable: no route of the web app takes an upload (content is seeded)', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/route\.tsx?$/.test(e)) files.push(p);
      }
    };
    walk(fileURLToPath(new URL('../../apps/web/src/app', import.meta.url)));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      expect(f, 'route name').not.toMatch(/upload/i);
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(
        /formData\s*\(|multipart\/form-data|\.arrayBuffer\s*\(\)\s*;?\s*\/\/ upload/,
      );
    }
  });
});

describe('D-offline result', () => {
  afterAll(() => {
    dc.unsubscribe('net.client.socket', onClientSocket);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('D-offline zero net.connect, Socket.connect, tls.connect, http(s).request, http2.connect, dns (callback and promises) and fetch calls, and no client socket on the channel, across the whole D run', () => {
    expect(trace.calls).toEqual([]);
  });
});
