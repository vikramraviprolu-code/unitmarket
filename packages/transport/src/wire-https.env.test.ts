import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OVERRIDE_ENV_NAMES, cleanProcess, loadHttpsWire, unloadHttpsWire } from './https-fake';
import type { WireRequest } from './wire';
import { SANDBOX_HOST } from './test-support';

// Moved from wire-fetch.env.test.ts (FIX-MVPB-SEAL2 M3, SEAL3 M-C) and extended (SEAL5 item f).
// The proxy and certificate overrides refused at boot are checked again on every request, because
// process.env can change after boot (NODE_TLS_REJECT_UNAUTHORIZED=0 is read by Node at each
// connection). The Wire is the real createHttpsWire(), loaded against fake node:https, node:tls and
// node:dns modules, so a request that gets through reaches only an in-memory fake.
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
  // SEAL5 item f: symlink handling changes which file a specifier resolves to
  '--preserve-symlinks',
  '--preserve-symlinks-main',
  '--preserve-symlinks=1',
  '--preserve-symlinks-main=1',
  // BU-1 review F3
  '--experimental-config-file',
  '--experimental-config-file=./c.json',
  '--experimental-default-config-file',
  '--insecure-http-parser',
];

const request = (): WireRequest => ({
  method: 'GET',
  url: `https://${SANDBOX_HOST}/v2/checkout/orders/ABC123`,
  headers: { authorization: 'Bearer placeholder' },
  body: null,
  timeout_ms: 1000,
});

let restoreArgv: () => void;
let loaded: Awaited<ReturnType<typeof loadHttpsWire>>;
beforeEach(async () => {
  restoreArgv = cleanProcess();
  loaded = await loadHttpsWire({ kind: 'response', chunks: ['{}'] });
});
afterEach(() => {
  restoreArgv();
  vi.unstubAllEnvs();
  unloadHttpsWire();
});

describe('the environment is rechecked on every request (M3, SEAL2)', () => {
  it('the override names include NODE_PRESERVE_SYMLINKS (SEAL5 item f) and NODE_PATH (BU-1 review F3)', () => {
    expect(OVERRIDE_ENV_NAMES).toContain('NODE_PRESERVE_SYMLINKS');
    expect(OVERRIDE_ENV_NAMES).toContain('NODE_PATH');
  });
  it('with a clean environment the request reaches the (fake) request function', async () => {
    const r = await loaded.createHttpsWire().request(request());
    expect(r).toMatchObject({ kind: 'response', status: 200 });
    expect(loaded.world.calls).toHaveLength(1);
  });
  it.each(OVERRIDE_ENV_NAMES.flatMap((n) => [n, n.toLowerCase()]))(
    'an override set AFTER the wire was built stops the next request: %s',
    async (name) => {
      const wire = loaded.createHttpsWire();
      expect((await wire.request(request())).kind).toBe('response');
      expect(loaded.world.calls).toHaveLength(1);
      vi.stubEnv(name, name.toUpperCase().includes('REJECT') ? '0' : 'x');
      expect(await wire.request(request())).toEqual({ kind: 'error', error: 'other' });
      expect(loaded.world.calls).toHaveLength(1);
      // Clearing it lets the next request through again: the check is per request, not a latch.
      vi.stubEnv(name, '');
      expect((await wire.request(request())).kind).toBe('response');
      expect(loaded.world.calls).toHaveLength(2);
    },
  );
  it.each(FLAGS)('a Node flag %s stops the request', async (flag) => {
    Object.defineProperty(process, 'execArgv', { value: [flag], configurable: true });
    expect(await loaded.createHttpsWire().request(request())).toEqual({
      kind: 'error',
      error: 'other',
    });
    expect(loaded.world.calls).toHaveLength(0);
  });
  it('NODE_TLS_REJECT_UNAUTHORIZED is refused, whatever the value text', async () => {
    for (const v of ['0', 'false', ' 0 ', '1']) {
      vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', v);
      expect(await loaded.createHttpsWire().request(request())).toEqual({
        kind: 'error',
        error: 'other',
      });
    }
    expect(loaded.world.calls).toHaveLength(0);
  });
  it('harmless flags do not stop the request', async () => {
    Object.defineProperty(process, 'execArgv', {
      value: ['--max-old-space-size=512', '--use-bundled-ca', '--preserve-symlinks-are-fine'],
      configurable: true,
    });
    expect((await loaded.createHttpsWire().request(request())).kind).toBe('response');
  });
});
