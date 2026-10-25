// MVP-C offline gate, adversarial part: the whole C run opens no socket. The four C test files are
// loaded from here (their tests register in this file and run in its module graph) with net.connect,
// net.createConnection, tls.connect, http(s).request and get, dns.lookup, resolve, resolve4, resolve6
// and fetch replaced by functions that record the call and throw. The last test reads the record: it
// must be empty. The first test checks the recording helper itself, so an empty record means "never
// called" and not "never watched". The C-11 restart test (scripts/c11-restart.integration.test.ts)
// spawns children; each child traces the same functions inside its own process and that test asserts
// they report none.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { bypassShapes, netViews, openRaw } from './c-net-probe';
import type { RawNet } from './c-net-probe';

vi.mock('server-only', () => ({}));

const { trace, patch, blocked, fetchStub, hooks } = vi.hoisted(() => {
  const trace = { calls: [] as string[] };
  const blocked =
    (label: string) =>
    (...args: unknown[]): never => {
      void args;
      trace.calls.push(label);
      throw new Error(`${label}: the C run is offline`);
    };
  const patch =
    (names: string[], module: string) => async (importOriginal: () => Promise<unknown>) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      const patched: Record<string, unknown> = { ...actual };
      for (const name of names) patched[name] = blocked(`${module}.${name}`);
      return { ...patched, default: patched };
    };
  const fetchStub = (...a: unknown[]): Promise<never> => {
    trace.calls.push(`fetch ${String(a[0])}`);
    return Promise.reject(new Error('fetch: the C run is offline'));
  };
  // Filled by the interception (CO-Gb): the unpatched functions, and a switch that lets the
  // Socket.prototype.connect guard call through, for the channel proof only.
  const hooks = {
    raw: undefined as RawNet | undefined,
    passThrough: undefined as ((on: boolean) => void) | undefined,
  };
  return { trace, patch, blocked, fetchStub, hooks };
});
vi.stubGlobal('fetch', fetchStub);
vi.mock('node:net', patch(['connect', 'createConnection'], 'net'));
vi.mock('node:tls', patch(['connect'], 'tls'));
vi.mock('node:http', patch(['request', 'get'], 'http'));
vi.mock('node:https', patch(['request', 'get'], 'https'));
vi.mock('node:dns', patch(['lookup', 'resolve', 'resolve4', 'resolve6'], 'dns'));

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
    expect(hooks.raw, 'the interception keeps the unpatched functions').toBeDefined();
    expect(hooks.passThrough, 'the interception can let the guard call through').toBeDefined();
    hooks.passThrough?.(true);
    try {
      if (hooks.raw !== undefined) await openRaw(hooks.raw);
    } finally {
      hooks.passThrough?.(false);
    }
    expect(trace.calls).toEqual(['net.client.socket', 'net.client.socket', 'net.client.socket']);
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
    vi.unstubAllGlobals();
  });
  it('C-offline zero net.connect, tls.connect, http(s).request, dns.lookup and fetch calls across the whole C run', () => {
    expect(trace.calls).toEqual([]);
  });
});
