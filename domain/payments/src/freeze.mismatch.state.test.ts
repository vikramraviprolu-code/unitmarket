// DP-2c item 2 (MVP-D): the overview says `orders.mismatch` is set whenever a PayPal order is frozen.
// Every transition of a PayPal order to `frozen` that is not made by apply.ts's freezePo goes through
// setPoState and then refreshOrder, which derives the flag. This file pins the flag on each of those
// four paths (one PayPal order of a pack held while the other is captured), so a later change that
// froze without refreshing would fail here. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import type { CaptureRes } from '@umsbx/contracts';
import { onBuyerReturn, runDue } from './index';
import { BUYER_A, approved, makeWorld } from './ops/support';
import type { Awaiting, OpsWorld } from './ops/support';
import { providerOrdersOf } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const PACK = { offers: ['ofr_1', 'ofr_3'] };
const DUPLICATE: CaptureRes = {
  kind: 'rejected',
  http: 422,
  name: 'UNPROCESSABLE_ENTITY',
  issue: 'DUPLICATE_INVOICE_ID',
  debug_id: 'D',
};
const ret = (ref: string) => onBuyerReturn(w.deps, { order_ref: ref, actor: BUYER_A });
const poIds = (a: Awaiting): string[] =>
  a.provider_orders.map((p) => p.provider_order_id as string);
const states = async (order_id: string): Promise<string[]> =>
  (await providerOrdersOf(w, order_id)).map((p) => p.state);
const orderRow = async (id: string) =>
  (
    await w.rows<{ status: string; mismatch: boolean }>(
      'SELECT status, mismatch FROM orders WHERE id = $1',
      [id],
    )
  )[0]!;

const frozenAlerts = (order_id: string) =>
  w.rows<{ reason: string; phase: string | null }>(
    "SELECT detail ->> 'reason' AS reason, detail ->> 'phase' AS phase FROM alerts WHERE kind = 'frozen_order' AND order_id = $1 ORDER BY created_at, id",
    [order_id],
  );

describe('DP-2c item 2: a frozen PayPal order always sets orders.mismatch', () => {
  it('capture.ts: DUPLICATE_INVOICE_ID on the first send of PO2 after PO1 was captured', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', DUPLICATE);
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);
    expect(await frozenAlerts(a.order_id)).toEqual([
      { reason: 'duplicate_invoice_id_p2', phase: null },
    ]);
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'paid_partial', mismatch: true });
  });

  it('reconcile.ts: DUPLICATE_INVOICE_ID on the retry of PO2 after PO1 was captured', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', { kind: 'timeout' });
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['captured', 'unresolved']);
    w.paypal.queue.capture.push(DUPLICATE);
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);
    expect(await frozenAlerts(a.order_id)).toEqual([
      { reason: 'duplicate_invoice_id_p2', phase: null },
    ]);
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'paid_partial', mismatch: true });
  });

  it('return.ts: the status read of PO2 before its capture does not match, PO1 already captured', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    const base = w.paypal.count('get');
    // reads of the return: 2 return reads, 1 pass read, 2 status reads; PO2 is tampered after PO1's.
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === base + 4) {
        w.paypal.beforeGet = null;
        w.paypal.tamperBy.set(poIds(a)[1]!, { payee: 'SBXEVILPAYEE' });
      }
    };
    await ret(a.order_ref);
    w.paypal.beforeGet = null;
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);
    expect(await frozenAlerts(a.order_id)).toEqual([
      { reason: 'precapture_unit_payee', phase: 'pre_capture' },
    ]);
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'paid_partial', mismatch: true });
  });

  it('due.ts: the continuation read of PO2 does not match, PO1 already captured', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    const base = w.paypal.count('get');
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === base + 4) {
        w.paypal.beforeGet = null;
        throw new Error('process died between the captures');
      }
    };
    await expect(ret(a.order_ref)).rejects.toThrow('died between the captures');
    w.paypal.beforeGet = null;
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    w.paypal.tamperBy.set(poIds(a)[1]!, { payee: 'SBXEVILPAYEE' });
    await runDue(w.deps, { max_items: 10 });
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);
    expect(await frozenAlerts(a.order_id)).toEqual([
      { reason: 'precapture_unit_payee', phase: 'continuation' },
    ]);
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'paid_partial', mismatch: true });
  });
});
