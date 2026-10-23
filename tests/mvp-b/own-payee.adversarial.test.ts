// BU-7 (D-028) adversarial: the omission is for our own merchant id and nothing else, the scope
// still refuses every payee before the gate, and a read-back that does not echo our own id freezes
// the order. No byte leaves the process: the Wire is a fake, the production Wire is never built.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPayPalAdapter } from '@umsbx/paypal';
import { makeSecret } from '@umsbx/config';
import type { CreateOrderReq } from '@umsbx/contracts';
import { OTHER, OWN, bootOwn } from './own-payee-support';
import type { OwnRig } from './own-payee-support';
import { FAKE_ID, FAKE_SECRET, makeRig, req } from './unseal-support';
import type { Rig } from './unseal-support';

vi.mock('server-only', () => ({}));
// Every rig opens and migrates its own in-memory database: slow on a loaded machine.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let rig: OwnRig | null = null;
const small: Rig[] = [];
afterEach(async () => {
  if (rig !== null) await rig.close();
  rig = null;
  for (const r of small.splice(0)) await r.close();
});
const tokenOrEmpty = (r: { url: string }) =>
  new URL(r.url).pathname === '/v1/oauth2/token'
    ? {
        kind: 'response' as const,
        status: 200,
        headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbgbu70001' },
        body: JSON.stringify({
          access_token: ['bu7', 'tok', 'placeholder'].join('-'),
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      }
    : {
        kind: 'response' as const,
        status: 200,
        headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbgbu70002' },
        body: '{}',
      };

const stripPayee = (units: Record<string, unknown>[]) =>
  units.map(({ payee: _dropped, ...rest }) => rest);

async function checkoutAndReturn(r: OwnRig, scenario: string | null = 'happy') {
  const order = await r.placeOrder();
  const co = await r.app.engine.payments.beginCheckout({
    order_id: order.order_id,
    actor: r.actor,
  });
  expect(co.ok).toBe(true);
  expect(r.model.approve(await r.providerOrderId(order.order_id), scenario)).toBe(true);
  await r.app.engine.payments.onBuyerReturn({ order_ref: order.order_ref, actor: r.actor });
  return order;
}

describe('another payee under mvp_b_polling stays blocked before the gate', () => {
  it('a publisher whose payee is not our own id: create is refused, nothing but the token call reaches the Wire', async () => {
    rig = await bootOwn({ publisher_payee: OTHER });
    const order = await rig.placeOrder();
    const co = await rig.app.engine.payments.beginCheckout({
      order_id: order.order_id,
      actor: rig.actor,
    });
    expect(co.ok).toBe(false);
    expect(rig.ops()).not.toContain('create_order');
    expect(rig.played.every((p) => !(p.body ?? '').includes('purchase_units'))).toBe(true);
    expect(rig.lines.some((l) => l.includes('payee_not_allowed'))).toBe(true);
    // the gate was never asked for a create: reservations equal the calls that went out
    expect(
      await rig.count(`SELECT count(*) AS c FROM audit_log WHERE action = 'gate.reserve'`),
    ).toBe(rig.played.length);
  }, 60_000);

  it('own id unset: even a payee that is our real id is never left out, so the create is refused', async () => {
    rig = await bootOwn({ own: null, publisher_payee: OWN });
    const order = await rig.placeOrder();
    const co = await rig.app.engine.payments.beginCheckout({
      order_id: order.order_id,
      actor: rig.actor,
    });
    expect(co.ok).toBe(false);
    expect(rig.ops()).not.toContain('create_order');
    expect(rig.lines.some((l) => l.includes('payee_not_allowed'))).toBe(true);
  }, 60_000);

  it('the same id in another case is another payee: refused', async () => {
    rig = await bootOwn({ publisher_payee: OWN.toLowerCase() });
    const order = await rig.placeOrder();
    const co = await rig.app.engine.payments.beginCheckout({
      order_id: order.order_id,
      actor: rig.actor,
    });
    expect(co.ok).toBe(false);
    expect(rig.ops()).not.toContain('create_order');
  }, 60_000);

  it('a body that names our own id as payee is still refused by the scope (the transport does not know the own id)', async () => {
    const r = await makeRig();
    small.push(r);
    const base = req.createOrder();
    const body = JSON.parse(base.body ?? '{}') as { purchase_units: Record<string, unknown>[] };
    body.purchase_units[0]!['payee'] = { merchant_id: OWN };
    const res = await r.outbound.transport.send({ ...base, body: JSON.stringify(body) });
    expect(res).toEqual({ kind: 'blocked', by: 'egress' });
    expect(r.log.events.filter((e) => e.msg === 'sandbox.send').at(-1)?.fields['reason']).toBe(
      'payee_not_allowed',
    );
    expect(r.counting.calls).toHaveLength(0);
    expect(await r.reservations()).toBe(0);
  });

  it('own id copied into another publisher unit: that unit keeps its payee and the order is refused before the gate', async () => {
    const r = await makeRig({ answer: tokenOrEmpty });
    small.push(r);
    const adapter = createPayPalAdapter({
      transport: r.outbound.transport,
      clock: r.clock,
      log: r.log,
      credentials: { client_id: makeSecret(FAKE_ID), client_secret: makeSecret(FAKE_SECRET) },
      record: async () => undefined,
      own_merchant_id: OWN,
    });
    const order: CreateOrderReq = {
      request_id: 'umsC-bu7-0123456789abcdef0123456789abcdef',
      order_ref: 'ord_BU7ADV1',
      units: [
        { reference_id: 'unit-1', payee_merchant_id: OWN, amount: { currency: 'USD', minor: 100 } },
        {
          reference_id: 'unit-2',
          payee_merchant_id: OTHER,
          amount: { currency: 'USD', minor: 100 },
        },
      ],
      return_url: 'https://shop.example.invalid/checkout/return?ref=ord_BU7ADV1',
      cancel_url: 'https://shop.example.invalid/checkout/cancel?ref=ord_BU7ADV1',
      scenario: null,
    };
    const res = await adapter.createOrder(order);
    expect(res.kind).toBe('blocked');
    const orderCalls = r.counting.calls.filter((c) => c.url.includes('/v2/checkout/orders'));
    expect(orderCalls).toHaveLength(0);
    expect(r.counting.calls.every((c) => !(c.body ?? '').includes(OTHER))).toBe(true);
    expect(r.log.events.filter((e) => e.msg === 'sandbox.send').at(-1)?.fields['reason']).toBe(
      'payee_not_allowed',
    );
  });
});

describe('a read-back that does not echo our own id freezes the order', () => {
  const frozenFlow = async (r: OwnRig, scenario: string | null) => {
    const order = await checkoutAndReturn(r, scenario);
    expect(await r.statusRow(order.order_ref)).toBe('frozen');
    expect(await r.count('SELECT count(*) AS c FROM entitlements')).toBe(0);
    // let the job loop run: no second create, no second capture, still frozen
    const jobs = await r.app.startJobs();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await jobs.stop();
    expect(r.ops().filter((o) => o === 'create_order')).toHaveLength(1);
    expect(r.ops().filter((o) => o === 'capture_order')).toHaveLength(1);
    expect(await r.statusRow(order.order_ref)).toBe('frozen');
    expect(await r.count('SELECT count(*) AS c FROM entitlements')).toBe(0);
    expect(
      await r.count(
        "SELECT count(*) AS c FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1 AND l.kind = 'sale'",
        [order.order_id],
      ),
    ).toBe(0);
    const creates = r.played.filter((p) => p.operation === 'create_order');
    expect(creates.every((p) => p.body === creates[0]?.body)).toBe(true);
  };

  it('PayPal echoes no payee: mismatch, frozen, one create, one capture, no access', async () => {
    rig = await bootOwn({ tamper: stripPayee });
    await frozenFlow(rig, 'happy');
  }, 90_000);

  it('PayPal echoes another merchant id: mismatch, frozen, one create, one capture, no access', async () => {
    rig = await bootOwn();
    await frozenFlow(rig, 'mismatch_payee');
  }, 90_000);

  it('the order model has no own id and echoes nothing for the omitted payee: frozen (a wrong setup is caught)', async () => {
    rig = await bootOwn({ model_payee: null });
    await frozenFlow(rig, 'happy');
  }, 90_000);

  it('the create body that went out never named a payee, and the same bytes would be resent on a retry', async () => {
    rig = await bootOwn({ tamper: stripPayee });
    await checkoutAndReturn(rig, 'happy');
    const create = rig.played.find((p) => p.operation === 'create_order');
    expect(create?.body).toBeTruthy();
    expect(create?.body).not.toContain('payee');
    expect(create?.body).not.toContain(OWN);
  }, 60_000);
});
