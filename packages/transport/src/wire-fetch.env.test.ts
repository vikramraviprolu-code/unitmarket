import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureNetworkBaseline, createFetchWire } from './wire-fetch';
import { SANDBOX_HOST, netSpies } from './test-support';
import type { WireRequest } from './wire';

// The platform fetch is a stub here that counts calls and never touches the network; every other
// way of opening a connection must stay at zero.
let spies: ReturnType<typeof netSpies>;
beforeEach(() => {
  spies = netSpies();
});
afterEach(() => {
  const others = Object.entries(spies.counts()).filter(
    ([k, n]) => k !== 'global fetch' && (n as number) > 0,
  );
  spies.spies['global fetch'].mockRestore();
  expect(others).toEqual([]);
});

// FIX-MVPB-SEAL2 M3. The proxy and certificate overrides refused at boot are checked again on every
// request, because process.env can change after boot (NODE_TLS_REJECT_UNAUTHORIZED=0 is read by
// Node at each connection). The platform fetch is replaced by a stub that fails the test if reached.
describe('M3 (SEAL2): the environment is rechecked on every request', () => {
  const NAMES = [
    'NODE_USE_ENV_PROXY',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_EXTRA_CA_CERTS',
    'NODE_OPTIONS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NODE_USE_SYSTEM_CA',
    'OPENSSL_CONF',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ];
  const FLAGS = [
    '--use-env-proxy',
    '--require',
    '-r',
    '--import',
    '--inspect',
    '--inspect-brk',
    '--inspect-wait',
    '--loader',
    '--experimental-loader',
    '--use-system-ca',
    '--use-openssl-ca',
    '--openssl-config',
    '--openssl-shared-config',
    '--loader=./x.mjs',
    '--require=./x.js',
    // FIX-MVPB-SEAL3 M-C
    '--inspect-port',
    '--inspect-port=9230',
    '--tls-keylog',
    '--tls-keylog=/tmp/k.log',
    '--heapsnapshot-signal',
    '--heapsnapshot-signal=SIGUSR2',
    '--heapsnapshot-near-heap-limit',
    '--heapsnapshot-near-heap-limit=3',
    '--experimental-network-inspection',
    '--secure-heap',
    '--secure-heap=1048576',
    '--tls-min-v1.0',
    '--tls-min-v1.1',
    '--conditions',
    '--conditions=dev',
    '-C',
    '--report-signal',
    '--report-on-signal',
    '--report-on-fatalerror',
    '--report-uncaught-exception',
    '--report-compact',
    '--report-dir',
    '--report-directory',
    '--report-filename',
    '--report-exclude-network',
    '--report-exclude-env',
    '--snapshot-blob',
    '--build-snapshot',
    '--snapshot-blob=/tmp/x.blob',
    '--report-dir=/tmp/r',
  ];
  const request = (): WireRequest => ({
    method: 'GET',
    url: `https://${SANDBOX_HOST}/v2/checkout/orders/ABC123`,
    headers: { authorization: 'Bearer placeholder' },
    body: null,
    timeout_ms: 1000,
  });
  let reached: number;
  let savedArgv: string[];
  beforeEach(() => {
    reached = 0;
    savedArgv = process.execArgv;
    // The test runner's own workers are started with --require; start from no Node flags at all.
    Object.defineProperty(process, 'execArgv', { value: [], configurable: true });
    // Start from a clean environment: the container running these tests sets HTTPS_PROXY.
    for (const n of NAMES) {
      vi.stubEnv(n, '');
      vi.stubEnv(n.toLowerCase(), '');
    }
    spies.spies['global fetch'].mockImplementation(async () => {
      reached += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'execArgv', { value: savedArgv, configurable: true });
  });

  it('with a clean environment the request reaches the (stubbed) platform call', async () => {
    const r = await createFetchWire(captureNetworkBaseline()).request(request());
    expect(r).toMatchObject({ kind: 'response', status: 200 });
    expect(reached).toBe(1);
  });
  it.each(NAMES.flatMap((n) => [n, n.toLowerCase()]))(
    'an override set AFTER the wire was built stops the next request: %s',
    async (name) => {
      const wire = createFetchWire(captureNetworkBaseline());
      expect((await wire.request(request())).kind).toBe('response');
      expect(reached).toBe(1);
      vi.stubEnv(name, name.toUpperCase().includes('REJECT') ? '0' : 'x');
      const r = await wire.request(request());
      expect(r).toEqual({ kind: 'error', error: 'other' });
      expect(reached).toBe(1);
      // Clearing it lets the next request through again: the check is per request, not a latch.
      vi.stubEnv(name, '');
      expect((await wire.request(request())).kind).toBe('response');
      expect(reached).toBe(2);
    },
  );
  it.each(FLAGS)('a Node flag %s stops the request', async (flag) => {
    Object.defineProperty(process, 'execArgv', { value: [flag], configurable: true });
    expect(await createFetchWire(captureNetworkBaseline()).request(request())).toEqual({
      kind: 'error',
      error: 'other',
    });
    expect(reached).toBe(0);
  });
  it('NODE_TLS_REJECT_UNAUTHORIZED=0 is refused, whatever the value text', async () => {
    for (const v of ['0', 'false', ' 0 ', '1']) {
      vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', v);
      expect(await createFetchWire(captureNetworkBaseline()).request(request())).toEqual({
        kind: 'error',
        error: 'other',
      });
    }
    expect(reached).toBe(0);
  });
  it('harmless flags do not stop the request', async () => {
    Object.defineProperty(process, 'execArgv', {
      value: ['--max-old-space-size=512', '--use-bundled-ca'],
      configurable: true,
    });
    expect((await createFetchWire(captureNetworkBaseline()).request(request())).kind).toBe(
      'response',
    );
  });
});

// FIX-MVPB-SEAL3 M-C. Replacing the global fetch, or installing another undici global dispatcher
// (a proxy agent, a custom TLS agent), changes where the next request goes without touching any
// variable. The Wire compares both with what they were when it was set up.
describe('M-C (SEAL3): a swapped global fetch or undici dispatcher stops the request', () => {
  const KEY = Symbol.for('undici.globalDispatcher.1');
  const request = (): WireRequest => ({
    method: 'GET',
    url: `https://${SANDBOX_HOST}/v2/checkout/orders/ABC123`,
    headers: { authorization: 'Bearer placeholder' },
    body: null,
    timeout_ms: 1000,
  });
  let reached: number;
  let savedArgv: string[];
  let savedDispatcher: unknown;
  beforeEach(() => {
    reached = 0;
    savedArgv = process.execArgv;
    Object.defineProperty(process, 'execArgv', { value: [], configurable: true });
    for (const n of [
      'HTTPS_PROXY',
      'https_proxy',
      'NODE_OPTIONS',
      'SSL_CERT_FILE',
      'NODE_EXTRA_CA_CERTS',
    ])
      vi.stubEnv(n, '');
    spies.spies['global fetch'].mockImplementation(async () => {
      reached += 1;
      return new Response('{}', { status: 200 });
    });
    savedDispatcher = Reflect.get(globalThis, KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    Reflect.set(globalThis, KEY, savedDispatcher);
    Object.defineProperty(process, 'execArgv', { value: savedArgv, configurable: true });
  });

  it('the baseline records the fetch and the dispatcher that exist when it is taken', () => {
    const b = captureNetworkBaseline();
    expect(b.fetchFn).toBe(globalThis.fetch);
    // Taking a baseline makes Node create its own default dispatcher (no network), so it is Node's.
    expect(b.dispatcher).toBe(Reflect.get(globalThis, KEY));
    expect(b.dispatcher).toBeDefined();
  });
  it('a fetch replaced after the baseline is refused, and neither fetch is called', async () => {
    const wire = createFetchWire(captureNetworkBaseline());
    expect((await wire.request(request())).kind).toBe('response');
    expect(reached).toBe(1);
    let other = 0;
    vi.stubGlobal('fetch', async () => {
      other += 1;
      return new Response('{}');
    });
    expect(await wire.request(request())).toEqual({ kind: 'error', error: 'other' });
    expect(other).toBe(0);
    expect(reached).toBe(1);
  });
  it('a different undici global dispatcher is refused, and restoring it lets requests through', async () => {
    const wire = createFetchWire(captureNetworkBaseline());
    Reflect.set(globalThis, KEY, { dispatch: () => false, constructor: { name: 'ProxyAgent' } });
    expect(await wire.request(request())).toEqual({ kind: 'error', error: 'other' });
    expect(reached).toBe(0);
    Reflect.set(globalThis, KEY, savedDispatcher);
    expect((await wire.request(request())).kind).toBe('response');
  });
  it('clearing the dispatcher is also a change (the property cannot be deleted, only overwritten)', async () => {
    const wire = createFetchWire(captureNetworkBaseline());
    Reflect.set(globalThis, KEY, undefined);
    expect(await wire.request(request())).toEqual({ kind: 'error', error: 'other' });
    expect(reached).toBe(0);
  });
  it('the default baseline is the one taken when the module loaded: a fetch spied on since then is refused', async () => {
    // netSpies() replaced globalThis.fetch after wire-fetch.ts was loaded, so the load-time
    // baseline no longer matches and the default Wire refuses before any call.
    expect(await createFetchWire().request(request())).toEqual({ kind: 'error', error: 'other' });
    expect(reached).toBe(0);
  });
});
