// BU-7 (D-028): an order for the publisher whose payee is our own merchant id goes create, approve,
// capture, read back with the payee echoed as our own id, on the testkit order model and on the
// fixtures. Synthetic: not PayPal evidence. The first owner run checks the real echo.
import { describe, expect, it } from 'vitest';
import { createPayPalAdapter } from '@umsbx/paypal';
import type { CreateOrderReq, OutboundRequest } from '@umsbx/contracts';
import { T0, fakeClock } from './clock';
import { createDryRunStack, createReqFor } from './index';

const OWN = 'SBXOWNMERCH01';
const FIXTURE_PAYEE = 'SBXMERCHANT01';
const quiet = { log: () => undefined, child: () => quiet };

const reqWith = (payee: string, tag = 'SBX0001'): CreateOrderReq => {
  const r = createReqFor(null, tag);
  return { ...r, units: r.units.map((u) => ({ ...u, payee_merchant_id: payee })) };
};
const bodyOf = (c: OutboundRequest): { purchase_units: Record<string, unknown>[] } =>
  JSON.parse(c.body ?? '{}');

async function rig(o: { own_merchant_id?: string | null; adapter_own?: string | null }) {
  const clock = fakeClock(T0);
  const stack = await createDryRunStack({
    clock,
    ...(o.own_merchant_id === undefined ? {} : { own_merchant_id: o.own_merchant_id }),
  });
  const adapter = createPayPalAdapter({
    transport: stack.transport,
    clock,
    log: quiet,
    credentials: null,
    record: async () => undefined,
    ...(o.adapter_own === undefined ? {} : { own_merchant_id: o.adapter_own }),
  });
  return { stack, adapter };
}

describe('order model: create without payee, echo of our own id', () => {
  it('create, approve, capture, read back: the payee is echoed as our own id and the capture is whole', async () => {
    const { stack, adapter } = await rig({ own_merchant_id: OWN, adapter_own: OWN });
    const req = reqWith(OWN);
    const created = await adapter.createOrder(req);
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;

    const sent = stack.calls().filter((c) => c.operation === 'create_order');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).not.toContain('payee');
    expect(sent[0]?.body).not.toContain(OWN);
    expect(bodyOf(sent[0]!).purchase_units[0]).not.toHaveProperty('payee');

    stack.approve(created.provider_order_id);
    const claim = await adapter.captureOrder({
      provider_order_id: created.provider_order_id,
      request_id: `umsK-${req.order_ref}`,
    });
    expect(claim.kind).toBe('claim');

    const read = await adapter.getOrder(created.provider_order_id);
    expect(read.kind).toBe('order');
    if (read.kind !== 'order') return;
    expect(read.units).toHaveLength(1);
    expect(read.units[0]?.payee_merchant_id).toBe(OWN);
    expect(read.units[0]?.amount.minor).toBe(500);
    expect(read.units[0]?.capture?.status).toBe('COMPLETED');
  });

  it('a read before approval already echoes our own id', async () => {
    const { adapter } = await rig({ own_merchant_id: OWN, adapter_own: OWN });
    const created = await adapter.createOrder(reqWith(OWN));
    if (created.kind !== 'created') throw new Error('not created');
    const read = await adapter.getOrder(created.provider_order_id);
    expect(read.kind === 'order' && read.units[0]?.payee_merchant_id).toBe(OWN);
  });

  it('a payee that is not ours stays in the body and is echoed as sent', async () => {
    const { stack, adapter } = await rig({ own_merchant_id: OWN, adapter_own: OWN });
    const created = await adapter.createOrder(reqWith('SBXOTHERMERCH2'));
    if (created.kind !== 'created') throw new Error('not created');
    const sent = stack.calls().find((c) => c.operation === 'create_order');
    expect(bodyOf(sent!).purchase_units[0]?.['payee']).toEqual({ merchant_id: 'SBXOTHERMERCH2' });
    const read = await adapter.getOrder(created.provider_order_id);
    expect(read.kind === 'order' && read.units[0]?.payee_merchant_id).toBe('SBXOTHERMERCH2');
  });

  it('the model echoes nothing for an omitted payee when it has no own id (so a wrongly wired setup shows as a mismatch)', async () => {
    const { adapter } = await rig({ adapter_own: OWN });
    const created = await adapter.createOrder(reqWith(OWN));
    if (created.kind !== 'created') throw new Error('not created');
    const read = await adapter.getOrder(created.provider_order_id);
    expect(read.kind === 'order' && read.units[0]?.payee_merchant_id).toBeNull();
  });

  it('the model echoes a different own id than the unit payee as that different id', async () => {
    const { adapter } = await rig({ own_merchant_id: 'SBXELSEMERCH02', adapter_own: OWN });
    const created = await adapter.createOrder(reqWith(OWN));
    if (created.kind !== 'created') throw new Error('not created');
    const read = await adapter.getOrder(created.provider_order_id);
    expect(read.kind === 'order' && read.units[0]?.payee_merchant_id).toBe('SBXELSEMERCH02');
  });

  it('the same request id replays the same order: one order, the same body', async () => {
    const { stack, adapter } = await rig({ own_merchant_id: OWN, adapter_own: OWN });
    const req = reqWith(OWN);
    const a = await adapter.createOrder(req);
    const b = await adapter.createOrder(req);
    expect(a.kind === 'created' && b.kind === 'created' && a.provider_order_id).toBe(
      b.kind === 'created' && b.provider_order_id,
    );
    const bodies = stack
      .calls()
      .filter((c) => c.operation === 'create_order')
      .map((c) => c.body);
    expect(new Set(bodies).size).toBe(1);
  });
});

describe('fixtures: the recorded happy order echoes the payee it names', () => {
  it('create without payee, then read: the fixture echo is our own id when that is the fixture payee', async () => {
    const { stack, adapter } = await rig({ adapter_own: FIXTURE_PAYEE });
    const req = { ...reqWith(FIXTURE_PAYEE), scenario: 'happy' };
    const created = await adapter.createOrder(req);
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const sent = stack.calls().find((c) => c.operation === 'create_order');
    expect(sent?.body).not.toContain('payee');
    const read = await adapter.getOrder(created.provider_order_id, 'happy');
    expect(read.kind).toBe('order');
    if (read.kind !== 'order') return;
    expect(read.units[0]?.payee_merchant_id).toBe(FIXTURE_PAYEE);
  });

  it('the mismatch_payee fixture still echoes another id: the difference stays visible', async () => {
    const { adapter } = await rig({ adapter_own: FIXTURE_PAYEE });
    const created = await adapter.createOrder({
      ...reqWith(FIXTURE_PAYEE),
      scenario: 'mismatch_payee',
    });
    if (created.kind !== 'created') throw new Error('not created');
    const read = await adapter.getOrder(created.provider_order_id, 'mismatch_payee');
    expect(read.kind === 'order' && read.units[0]?.payee_merchant_id).not.toBe(FIXTURE_PAYEE);
  });
});
