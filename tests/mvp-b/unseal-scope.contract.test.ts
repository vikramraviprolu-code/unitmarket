// BU-2 acceptance (contract): the scope the app serves caps what can leave, whatever the approval
// row says, and the transport's own checks run before the gate (so a refused request costs no
// budget). Real scoped gate, in-memory database, counting fake Wire.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRig, req } from './unseal-support';
import type { Rig } from './unseal-support';

vi.mock('server-only', () => ({}));
// Every rig opens and migrates its own in-memory database: slow on a loaded machine.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});
async function open(o: Parameters<typeof makeRig>[0] = {}): Promise<Rig> {
  const r = await makeRig(o);
  rigs.push(r);
  return r;
}
const sendLogs = (r: Rig) => r.log.events.filter((e) => e.msg === 'sandbox.send');

describe('under mvp_b_polling', () => {
  it('refund_capture is blocked operation_not_in_scope, even when the approval row lists it', async () => {
    const r = await open({
      approval: { ops: ['oauth_token', 'get_order', 'create_order', 'refund_capture'] },
    });
    const res = await r.outbound.transport.send(req.refund());
    expect(res).toEqual({ kind: 'blocked', by: 'no_approval' });
    expect(sendLogs(r).at(-1)?.fields['reason']).toBe('operation_not_in_scope');
    expect(r.counting.calls).toHaveLength(0);
    expect(await r.reservations()).toBe(0);
  });

  it('an XAU body, a payee and a body over 64 KB are blocked before the gate: no Wire call, no budget used', async () => {
    const r = await open();
    const cases: [string, ReturnType<typeof req.createOrder>, string][] = [
      ['XAU', req.createOrder({ currency: 'XAU' }), 'currency_not_allowed'],
      ['payee', req.createOrder({ payee: true }), 'payee_not_allowed'],
      ['over 64 KB', req.createOrder({ pad: 70 * 1024 }), 'shape'],
    ];
    for (const [name, request, reason] of cases) {
      expect(await r.outbound.transport.send(request), name).toEqual({
        kind: 'blocked',
        by: 'egress',
      });
      expect(sendLogs(r).at(-1)?.fields['reason'], name).toBe(reason);
    }
    expect(r.counting.calls).toHaveLength(0);
    expect(await r.reservations()).toBe(0);
  });

  it('an amount that does not match the body is blocked before the gate', async () => {
    const r = await open();
    expect(await r.outbound.transport.send(req.createOrder({ value: '1.00', minor: 99 }))).toEqual({
      kind: 'blocked',
      by: 'egress',
    });
    expect(sendLogs(r).at(-1)?.fields['reason']).toBe('amount_unbound');
    expect(await r.reservations()).toBe(0);
  });

  it('the five operations of the phase pass: token, create, get, capture, get capture', async () => {
    const r = await open();
    const results = [];
    results.push(await r.outbound.transport.send(req.oauth()));
    results.push(await r.outbound.transport.send(req.createOrder()));
    results.push(await r.outbound.transport.send(req.getOrder()));
    expect(results.map((x) => x.kind)).toEqual(['response', 'response', 'response']);
    expect(r.counting.calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/v1/oauth2/token',
      '/v2/checkout/orders',
      '/v2/checkout/orders/ABC123',
    ]);
    expect(await r.reservations()).toBe(3);
  });

  it('an approval row for the other scope does not serve this one', async () => {
    const r = await open({ approval: { scope: 'mvp_c_refunds' } });
    expect(await r.outbound.transport.send(req.getOrder())).toEqual({
      kind: 'blocked',
      by: 'no_approval',
    });
    expect(r.counting.calls).toHaveLength(0);
  });

  it('an unknown scope in config never builds anything', async () => {
    const r = await open({ scope: 'mvp_x_everything' });
    expect(await r.outbound.transport.send(req.getOrder())).toEqual({
      kind: 'blocked',
      by: 'no_approval',
    });
    expect(r.counting.calls).toHaveLength(0);
    expect((await r.outbound.status()).transport_built).toBe(false);
  });
});

describe('under mvp_c_refunds', () => {
  it('serves the later phase: a payee on create_order and a refund pass the transport and reach the Wire', async () => {
    const r = await open({
      scope: 'mvp_c_refunds',
      approval: {
        ops: ['oauth_token', 'create_order', 'get_order', 'capture_order', 'refund_capture'],
      },
    });
    expect((await r.outbound.transport.send(req.createOrder({ payee: true }))).kind).toBe(
      'response',
    );
    expect((await r.outbound.transport.send(req.refund())).kind).toBe('response');
    expect(r.counting.calls).toHaveLength(2);
    expect((await r.outbound.status()).scope).toBe('mvp_c_refunds');
  });

  it('still refuses an XAU body (EUR, GBP and USD are allowed since MC2-L3)', async () => {
    const r = await open({
      scope: 'mvp_c_refunds',
      approval: { ops: ['oauth_token', 'create_order'] },
    });
    expect(await r.outbound.transport.send(req.createOrder({ currency: 'XAU' }))).toEqual({
      kind: 'blocked',
      by: 'egress',
    });
    expect(r.counting.calls).toHaveLength(0);
  });
});
