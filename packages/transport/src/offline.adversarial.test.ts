import net from 'node:net';
import tls from 'node:tls';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDryRunTransport } from './dryrun';
import { loadFixtures } from './fixture-store';
import { createSandboxTransport } from './sandbox';
import { fixedClock, memoryLogger, openGate, req } from './test-support';

const ROOT = fileURLToPath(new URL('../../../fixtures/paypal/', import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('offline_opens_no_socket (A-02)', () => {
  it('offline_opens_no_socket: a full dry-run journey of 6 calls opens no socket and calls no fetch', async () => {
    const netConnect = vi.spyOn(net, 'connect');
    const netCreate = vi.spyOn(net, 'createConnection');
    const tlsConnect = vi.spyOn(tls, 'connect');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const fixtures = await loadFixtures(join(ROOT, 'synthetic'));
    const t = createDryRunTransport({
      fixtures,
      gate: openGate(),
      clock: fixedClock(),
      default_scenario: 'happy',
      log: memoryLogger(),
    });

    const results = [
      await t.send(req('create_order', '/v2/checkout/orders')),
      await t.send(req('get_order', '/v2/checkout/orders/SBXHAPPYORD00001')),
      await t.send(req('capture_order', '/v2/checkout/orders/SBXHAPPYORD00001/capture')),
      await t.send(req('get_order', '/v2/checkout/orders/SBXHAPPYORD00001')),
      await t.send(req('get_capture', '/v2/payments/captures/SBXHAPPYCAP00001')),
      await t.send(req('refund_capture', '/v2/payments/captures/SBXHAPPYCAP00001/refund')),
    ];
    expect(results.map((r) => (r.kind === 'response' ? r.status : r.kind))).toEqual([
      201, 200, 201, 200, 200, 201,
    ]);

    // the sealed sandbox stub and a refused request are offline too
    await createSandboxTransport().send(req('get_order', '/v2/checkout/orders/SBXHAPPYORD00001'));
    await t.send(req('get_order', 'https://evil.example/x'));

    expect(netConnect).not.toHaveBeenCalled();
    expect(netCreate).not.toHaveBeenCalled();
    expect(tlsConnect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
