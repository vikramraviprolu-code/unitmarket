// DP-5 (MVP-D) adversarial tests for the composite web layer: a return that carries something it
// should not, the dry-run model's duplicate invoice id, and the strings a buyer must never see.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor, OutboundRequest } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { createDryRunModel } from './server/dryrun-model';
import {
  HARBOUR_FERRY,
  HARBOUR_TIDE,
  QUAY_MARKET,
  QUAY_WALK,
  bootPackApp,
  buyer,
  runPack,
  startPack,
} from './composite-support';

vi.mock('server-only', () => ({}));

let app: App;
let A: Actor;
let B: Actor;
beforeAll(async () => {
  app = await bootPackApp();
  A = await buyer(app, 'a');
  B = await buyer(app, 'b');
});
afterAll(async () => {
  await app.close();
});

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await app.db.query<{ c: string | number }>(sql, params)).rows[0]!.c);

describe('return with something it should not carry', () => {
  it("return with a forged token or another buyer's ref: 404 or ignored, no capture", async () => {
    const o = await startPack(app, A, [HARBOUR_TIDE, QUAY_MARKET]);
    const ops = () =>
      count(
        `SELECT count(*) AS c FROM operations WHERE order_id = $1 AND kind = 'capture' AND state <> 'prepared'`,
        [o.order_id],
      );
    const before = await ops();
    // Another buyer's reference, a forged PayPal token and a malformed reference name no order.
    for (const ref of [o.order_ref, 'SBXMODELORD000001', "x'; DROP TABLE orders; --", '']) {
      const r = await app.engine.payments.onBuyerReturn({
        order_ref: ref,
        actor: B,
        scenario: null,
      });
      expect(r.ok, ref).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('not_found');
    }
    // B cannot approve A's PayPal order on the dry run either.
    expect(
      await app.engine.dryRunApprove({
        order_ref: o.order_ref,
        actor: B,
        scenario: 'happy',
        position: 1,
      }),
    ).toBe(false);
    expect(await app.engine.checkoutSteps({ order_ref: o.order_ref, actor: B })).toBeNull();
    expect(await ops()).toBe(before);
    // Nothing was approved at the pretend PayPal: the owner's own return reads, sees nothing approved
    // and captures nothing.
    const mine = await app.engine.payments.onBuyerReturn({
      order_ref: o.order_ref,
      actor: A,
      scenario: null,
    });
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      expect(mine.value.status).toBe('awaiting_buyer');
      expect(mine.value.next?.step).toBe(1);
    }
    expect(await ops()).toBe(before);
    expect(
      await count(
        'SELECT count(*) AS c FROM order_units WHERE order_id = $1 AND capture_id IS NOT NULL',
        [o.order_id],
      ),
    ).toBe(0);
  });

  it('a scenario that is not a scenario id is refused by the dry-run approval', async () => {
    const o = await startPack(app, B, [HARBOUR_FERRY, QUAY_WALK]);
    expect(
      await app.engine.dryRunApprove({
        order_ref: o.order_ref,
        actor: B,
        scenario: '../../etc',
        position: 1,
      }),
    ).toBe(false);
    expect(
      await app.engine.dryRunApprove({
        order_ref: o.order_ref,
        actor: B,
        scenario: 'happy',
        position: 7,
      }),
    ).toBe(false);
  });
});

describe('the dry-run model refuses a reused invoice id for one payee', () => {
  const clock = { now: () => new Date('2026-10-29T10:00:00Z') };
  const create = (
    m: ReturnType<typeof createDryRunModel>,
    rid: string,
    payee: string | null,
    invoice: string,
  ) => {
    const req: OutboundRequest = {
      operation: 'create_order',
      method: 'POST',
      path: '/v2/checkout/orders',
      headers: { 'PayPal-Request-Id': rid },
      body: JSON.stringify({
        purchase_units: [
          {
            reference_id: 'u1',
            custom_id: 'ord_x',
            invoice_id: invoice,
            amount: { currency_code: 'USD', value: '1.50' },
            ...(payee === null ? {} : { payee: { merchant_id: payee } }),
          },
        ],
      }),
      order_ref: null,
      amount_minor: null,
      scenario: null,
    };
    const out = m.send(req);
    if (out.kind !== 'response') throw new Error('no response');
    return { status: out.status, body: JSON.parse(out.body) as { details?: { issue: string }[] } };
  };

  it('dry run: a reused invoice id for one payee is DUPLICATE_INVOICE_ID', () => {
    const m = createDryRunModel(clock);
    expect(create(m, 'k1', 'SBXPAYEE00001', 'inv-1').status).toBe(201);
    const dup = create(m, 'k2', 'SBXPAYEE00001', 'inv-1');
    expect(dup.status).toBe(422);
    expect(dup.body.details?.[0]?.issue).toBe('DUPLICATE_INVOICE_ID');
    // The same request id still replays the first answer; another payee or invoice is fine.
    expect(create(m, 'k1', 'SBXPAYEE00001', 'inv-1').status).toBe(201);
    expect(create(m, 'k3', 'SBXPAYEE00002', 'inv-1').status).toBe(201);
    expect(create(m, 'k4', 'SBXPAYEE00001', 'inv-2').status).toBe(201);
  });

  it('an own-account create (no payee named) counts as one payee too', () => {
    const m = createDryRunModel(clock, { own_merchant_id: 'SBXOWNERTEST1' });
    expect(create(m, 'k1', null, 'inv-9').status).toBe(201);
    expect(create(m, 'k2', 'SBXOWNERTEST1', 'inv-9').status).toBe(422);
    expect(create(m, 'k3', null, 'inv-9').status).toBe(422);
  });
});

describe('what a buyer must never see', () => {
  it('no merchant id, PayPal order id or reason code in any buyer view', async () => {
    const run = await runPack(app, A, [HARBOUR_FERRY, QUAY_WALK], ['happy', 'mismatch_payee']);
    const merchants = (
      await app.db.query<{ m: string }>(
        'SELECT paypal_merchant_id AS m FROM publishers WHERE paypal_merchant_id IS NOT NULL',
      )
    ).rows.map((r) => r.m);
    const reasons = (
      await app.db.query<{ r: string }>(
        `SELECT status_reason AS r FROM order_units WHERE order_id = $1 AND status_reason IS NOT NULL
         UNION SELECT mismatch_reason FROM order_units WHERE order_id = $1 AND mismatch_reason IS NOT NULL`,
        [run.order_id],
      )
    ).rows.map((r) => r.r);
    const poIds = (
      await app.db.query<{ id: string }>(
        'SELECT provider_order_id AS id FROM provider_orders WHERE order_id = $1',
        [run.order_id],
      )
    ).rows.map((r) => r.id);
    expect(merchants.length).toBeGreaterThan(0);
    expect(poIds.length).toBe(2);
    const steps = await app.engine.checkoutSteps({ order_ref: run.order_ref, actor: A });
    const shown = JSON.stringify([
      await app.engine.approvalView({ approval_id: run.approval_id, actor: A }),
      await app.engine.orderView({ order_ref: run.order_ref, actor: A }),
      steps,
      await app.engine.library({ actor: A }),
      ...run.returns.map((r) =>
        r.ok
          ? {
              ...r.value,
              next: r.value.next === null ? null : { ...r.value.next, approve_url: '' },
            }
          : r.error,
      ),
    ]);
    for (const secret of [
      ...merchants,
      ...poIds,
      'SBXMODELORD',
      'precapture_',
      'payee_mismatch',
      'merchant',
    ]) {
      expect(shown, secret).not.toContain(secret);
    }
    for (const reason of reasons) expect(shown, reason).not.toContain(reason);
  });
});
