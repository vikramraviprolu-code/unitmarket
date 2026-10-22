import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFetchWire } from './wire-fetch';
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
    const r = await createFetchWire().request(request());
    expect(r).toMatchObject({ kind: 'response', status: 200 });
    expect(reached).toBe(1);
  });
  it.each(NAMES.flatMap((n) => [n, n.toLowerCase()]))(
    'an override set AFTER the wire was built stops the next request: %s',
    async (name) => {
      const wire = createFetchWire();
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
    expect(await createFetchWire().request(request())).toEqual({ kind: 'error', error: 'other' });
    expect(reached).toBe(0);
  });
  it('NODE_TLS_REJECT_UNAUTHORIZED=0 is refused, whatever the value text', async () => {
    for (const v of ['0', 'false', ' 0 ', '1']) {
      vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', v);
      expect(await createFetchWire().request(request())).toEqual({ kind: 'error', error: 'other' });
    }
    expect(reached).toBe(0);
  });
  it('harmless flags do not stop the request', async () => {
    Object.defineProperty(process, 'execArgv', {
      value: ['--max-old-space-size=512', '--use-bundled-ca'],
      configurable: true,
    });
    expect((await createFetchWire().request(request())).kind).toBe('response');
  });
});
