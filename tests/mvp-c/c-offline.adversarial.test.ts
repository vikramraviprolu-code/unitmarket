// MVP-C offline gate, adversarial part: the whole C run opens no socket. The four C test files are
// loaded from here (their tests register in this file and run in its module graph) with net.connect,
// net.createConnection, tls.connect, http(s).request and get, dns.lookup, resolve, resolve4, resolve6
// and fetch replaced by functions that record the call and throw. The last test reads the record: it
// must be empty. The first test checks the recording helper itself, so an empty record means "never
// called" and not "never watched". The C-11 restart test (scripts/c11-restart.integration.test.ts)
// spawns children; each child traces the same functions inside its own process and that test asserts
// they report none.
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { trace, patch, blocked, fetchStub } = vi.hoisted(() => {
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
  return { trace, patch, blocked, fetchStub };
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
