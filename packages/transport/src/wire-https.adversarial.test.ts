import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanProcess, loadHttpsWire, unloadHttpsWire } from './https-fake';
import { SANDBOX_HOST } from './test-support';
import type { WireRequest } from './wire';

// BU-1 adversarial. The production Wire is the real createHttpsWire(), loaded against fake
// node:https, node:tls and node:dns modules: anything that gets through reaches an in-memory fake,
// and "the replacement was called" is a count on a spy, never a real connection.
const KEY = Symbol.for('undici.globalDispatcher.1');
const request = (): WireRequest => ({
  method: 'GET',
  url: `https://${SANDBOX_HOST}/v2/checkout/orders/ABC123`,
  headers: { authorization: 'Bearer placeholder' },
  body: null,
  timeout_ms: 1000,
});
const refused = { kind: 'error', error: 'other' } as const;

let restoreArgv: () => void;
let loaded: Awaited<ReturnType<typeof loadHttpsWire>>;
let savedDispatcher: unknown;
beforeEach(async () => {
  restoreArgv = cleanProcess();
  savedDispatcher = Reflect.get(globalThis, KEY);
  loaded = await loadHttpsWire({ kind: 'response', chunks: ['{"ok":true}'] });
});
afterEach(() => {
  restoreArgv();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Reflect.set(globalThis, KEY, savedDispatcher);
  unloadHttpsWire();
});

describe('Next.js patches fetch; the Wire does not care', () => {
  it('globalThis.fetch replaced after load: the wire still works and the fetch spy is called 0 times', async () => {
    const wire = loaded.createHttpsWire();
    const spy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', spy);
    const r = await wire.request(request());
    expect(r).toMatchObject({ kind: 'response', status: 200, body: '{"ok":true}' });
    expect(spy).toHaveBeenCalledTimes(0);
    expect(loaded.world.calls).toHaveLength(1);
  });
  it('globalThis.fetch replaced BEFORE the wire is built works the same', async () => {
    const spy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', spy);
    const r = await loaded.createHttpsWire().request(request());
    expect(r.kind).toBe('response');
    expect(spy).toHaveBeenCalledTimes(0);
  });
  it('globalThis.fetch deleted or set to a throwing function: no effect', async () => {
    const wire = loaded.createHttpsWire();
    vi.stubGlobal('fetch', () => {
      throw new Error('must not be called');
    });
    expect((await wire.request(request())).kind).toBe('response');
    vi.stubGlobal('fetch', undefined);
    expect((await wire.request(request())).kind).toBe('response');
  });
  it('undici global dispatcher replaced: no effect', async () => {
    const wire = loaded.createHttpsWire();
    const dispatch = vi.fn(() => false);
    Reflect.set(globalThis, KEY, { dispatch, constructor: { name: 'ProxyAgent' } });
    expect((await wire.request(request())).kind).toBe('response');
    expect(dispatch).toHaveBeenCalledTimes(0);
    Reflect.set(globalThis, KEY, undefined);
    expect((await wire.request(request())).kind).toBe('response');
  });
});

describe('https.request, tls.connect or dns.lookup replaced after load: refused other, zero calls to the replacement', () => {
  it.each([
    ['https.request', 'https', 'request'],
    ['tls.connect', 'tls', 'connect'],
    ['dns.lookup', 'dns', 'lookup'],
  ] as const)('%s', async (_name, mod, key) => {
    const wire = loaded.createHttpsWire();
    expect((await wire.request(request())).kind).toBe('response');
    const target = loaded.world[mod] as Record<string, unknown>;
    const original = target[key];
    const replacement = vi.fn(() => {
      throw new Error('the replacement must never be called');
    });
    target[key] = replacement;
    expect(await wire.request(request())).toEqual(refused);
    expect(replacement).toHaveBeenCalledTimes(0);
    // the original request function saw only the first, honest request
    expect(loaded.world.calls).toHaveLength(1);
    target[key] = original;
    expect((await wire.request(request())).kind).toBe('response');
    expect(loaded.world.calls).toHaveLength(2);
  });
  it('a replacement installed BEFORE the first request but AFTER the module loaded is also refused', async () => {
    const replacement = vi.fn();
    loaded.world.https['request'] = replacement;
    expect(await loaded.createHttpsWire().request(request())).toEqual(refused);
    expect(replacement).toHaveBeenCalledTimes(0);
    expect(loaded.world.calls).toHaveLength(0);
  });
});

describe('NODE_OPTIONS or --import set after boot: refused other', () => {
  it.each([
    ['NODE_OPTIONS', '--require ./evil.js'],
    ['NODE_OPTIONS', '--import ./evil.mjs'],
    ['HTTPS_PROXY', 'http://127.0.0.1:9'],
    ['NODE_EXTRA_CA_CERTS', '/tmp/evil.pem'],
    ['NODE_PRESERVE_SYMLINKS', '1'],
  ])('%s=%s', async (name, value) => {
    const wire = loaded.createHttpsWire();
    vi.stubEnv(name, value);
    expect(await wire.request(request())).toEqual(refused);
    expect(loaded.world.calls).toHaveLength(0);
  });
  it.each([
    '--import',
    '--import=./evil.mjs',
    '--require',
    '--loader=./l.mjs',
    '--preserve-symlinks',
  ])('execArgv %s', async (flag) => {
    const wire = loaded.createHttpsWire();
    Object.defineProperty(process, 'execArgv', { value: [flag], configurable: true });
    expect(await wire.request(request())).toEqual(refused);
    expect(loaded.world.calls).toHaveLength(0);
  });
  it('the lower-case spelling of an override variable is refused too', async () => {
    const wire = loaded.createHttpsWire();
    vi.stubEnv('https_proxy', 'http://127.0.0.1:9');
    expect(await wire.request(request())).toEqual(refused);
  });
});

describe('a hostile server', () => {
  it('a __proto__ response header does not pollute the headers object', async () => {
    const hostile = await loadHttpsWire({
      kind: 'response',
      headers: JSON.parse('{"__proto__":"x","content-type":"text/plain"}') as Record<
        string,
        string
      >,
      chunks: ['ok'],
    });
    const r = await hostile.createHttpsWire().request(request());
    expect(r.kind).toBe('response');
    if (r.kind !== 'response') return;
    expect(Object.getPrototypeOf(r.headers)).toBe(Object.prototype);
    expect(Object.hasOwn(r.headers, '__proto__')).toBe(false);
    expect(r.headers['content-type']).toBe('text/plain');
    expect(({} as Record<string, unknown>)['content-type']).toBeUndefined();
  });
  it('a redirect to another host is not followed and the other host is never contacted', async () => {
    const redirect = await loadHttpsWire({
      kind: 'response',
      status: 307,
      headers: { location: 'https://evil.example/steal' },
    });
    const r = await redirect.createHttpsWire().request(request());
    expect(r).toMatchObject({ kind: 'response', status: 307 });
    expect(redirect.world.calls).toHaveLength(1);
    expect(redirect.world.calls.map((c) => c.options['hostname'])).toEqual([SANDBOX_HOST]);
  });
  it('a server that resets after the head gives reset and the Wire stays usable', async () => {
    const reset = await loadHttpsWire({ kind: 'response', chunks: ['{'], then: 'reset' });
    const wire = reset.createHttpsWire();
    expect(await wire.request(request())).toEqual({ kind: 'error', error: 'reset' });
    expect(await wire.request(request())).toEqual({ kind: 'error', error: 'reset' });
  });
});
