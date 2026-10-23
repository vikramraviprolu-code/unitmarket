// CO-4 contract tests: the shapes refunds put on the wires of the system. What requestRefund and
// executeRefund answer, what reaches the PayPal port, what lands in the ledger, the receipt, the
// audit log and the alerts. Every value is parsed with the schema of @umsbx/contracts, so a change
// to a shape (a new key, a string for a number) fails here first. Real PGlite, synthetic rows.
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuditEntrySchema,
  LedgerEntrySchema,
  OrderReadUnitSchema,
  ReceiptSchema,
  RefundReqSchema,
} from '@umsbx/contracts';
import { listLedger } from '@umsbx/ledger';
import { getReceiptForBuyer } from '@umsbx/receipts';
import { MAX_REQUEST_ID_LENGTH, executeRefund, reconcileOrder, requestRefund } from './index';
import { cancelRefundRequest } from './refunds';
import { OPERATOR, paid } from './ops/support';
import { makeRemainingWorld } from './remaining-world';
import type { RemainingWorld } from './remaining-world';

let w: RemainingWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const usd = (minor: number) => ({ currency: 'USD', minor });

async function setup() {
  w = await makeRemainingWorld({ price: 500 });
  const a = await paid(w);
  const unit = (
    await w.rows<{ id: string; capture_id: string }>(
      'SELECT id, capture_id FROM order_units WHERE order_id = $1',
      [a.order_id],
    )
  )[0]!;
  return { a, unit };
}

describe('requestRefund answers', () => {
  it('has exactly the documented refusal codes, each as { ok: false, error: { code } }', async () => {
    const { unit } = await setup();
    const codes = new Set<string>();
    const ask = async (i: Partial<Parameters<typeof requestRefund>[1]>) => {
      const r = await requestRefund(w.deps, {
        unit_id: unit.id,
        amount: usd(100),
        reason: 'x',
        actor: OPERATOR,
        ...i,
      });
      if (!r.ok) {
        expect(Object.keys(r)).toEqual(['ok', 'error']);
        expect(Object.keys(r.error)).toEqual(['code']);
        codes.add(r.error.code);
      }
      return r;
    };
    await ask({ actor: { kind: 'buyer', buyer_id: 'buy_A' } });
    await ask({ actor: { kind: 'operator', operator_id: 'opr_1', mfa: false } });
    await ask({ unit_id: 'unt_unknown' });
    await ask({ amount: usd(9_999) });
    await ask({ amount: { currency: 'EUR', minor: 100 } });
    await w.rows('UPDATE orders SET mismatch = true');
    await ask({}); // a frozen unit
    await w.rows('UPDATE orders SET mismatch = false');
    w.switches.refunds_enabled = false;
    await ask({});
    w.switches.refunds_enabled = true;
    await ask({});
    await ask({}); // a second one while the first is open
    expect([...codes].sort()).toEqual(
      [
        'mfa_required',
        'not_captured',
        'not_operator',
        'over_refund',
        'refund_in_flight',
        'refunds_off',
        'unit_frozen',
      ].sort(),
    );
  });

  it('a success is { ok: true, value: { refund_request_id } } with a request id', async () => {
    const { unit } = await setup();
    const r = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    expect(r).toEqual({
      ok: true,
      value: { refund_request_id: expect.stringMatching(/^rfr_[0-9a-z]{26}$/) },
    });
  });
});

describe('cancelRefundRequest answers', () => {
  it('has exactly the documented refusal codes and the success shape', async () => {
    const { unit } = await setup();
    const rq = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: usd(100),
      reason: 'x',
      actor: OPERATOR,
    });
    if (!rq.ok) throw new Error('refused');
    const id = rq.value.refund_request_id;
    const codes = new Set<string>();
    const ask = async (request: string, actor: Parameters<typeof cancelRefundRequest>[2]) => {
      const r = await cancelRefundRequest(w.deps, request, actor);
      if (!r.ok) {
        expect(Object.keys(r)).toEqual(['ok', 'error']);
        expect(Object.keys(r.error)).toEqual(['code']);
        codes.add(r.error.code);
      }
      return r;
    };
    await ask(id, { kind: 'buyer', buyer_id: 'buy_A' });
    await ask(id, { kind: 'operator', operator_id: 'opr_1', mfa: false });
    await ask('rfr_unknown', OPERATOR);
    expect(await ask(id, OPERATOR)).toEqual({ ok: true, value: { refund_request_id: id } });
    await ask(id, OPERATOR); // already cancelled
    expect([...codes].sort()).toEqual(['mfa_required', 'not_found', 'not_operator', 'wrong_state']);
  });
});

describe('what reaches the PayPal port and the audit log', () => {
  it('the refund call is a RefundReq: capture id, derived key within 108 characters, the amount as stored, the reason as note', async () => {
    const { unit } = await setup();
    const r = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: usd(200),
      reason: 'goodwill',
      actor: OPERATOR,
    });
    if (!r.ok) throw new Error('refused');
    await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
    const sent = w.sends();
    expect(sent).toHaveLength(1);
    const req = RefundReqSchema.parse({
      capture_id: sent[0]!.capture_id,
      request_id: sent[0]!.request_id,
      amount: sent[0]!.amount,
      note: 'goodwill',
    });
    expect(req.capture_id).toBe(unit.capture_id);
    expect(req.request_id).toBe(`umsR-${r.value.refund_request_id}`);
    expect(req.request_id.length).toBeLessThanOrEqual(MAX_REQUEST_ID_LENGTH);
    expect(req.amount).toEqual(usd(200));
  });

  it('audit entries of a refund parse as AuditEntry and carry no secret or MFA material', async () => {
    const { unit } = await setup();
    const r = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: usd(200),
      reason: 'goodwill',
      actor: OPERATOR,
    });
    if (!r.ok) throw new Error('refused');
    await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
    expect(w.audits.length).toBeGreaterThan(0);
    for (const e of w.audits) AuditEntrySchema.parse(e);
    const requested = w.audits.find((e) => e.action === 'refund.requested')!;
    expect(requested.actor).toEqual(OPERATOR);
    expect(requested.target).toBe(r.value.refund_request_id);
    expect(requested.detail).toEqual({ unit_id: unit.id, amount_minor: 200, currency: 'USD' });
    expect(JSON.stringify(w.audits)).not.toMatch(/secret|token|password|totp/i);
  });
});

describe('what a booked dashboard refund writes', () => {
  it('the ledger entry, the receipt version and the unit satisfy their schemas', async () => {
    const { a, unit } = await setup();
    const id = w.dashboard(unit.capture_id, 150);
    await reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'poll' });
    const entries = (await listLedger(w.db, { unit_id: unit.id })).filter(
      (e) => e.kind === 'refund',
    );
    expect(entries).toHaveLength(1);
    const entry = LedgerEntrySchema.parse(entries[0]);
    expect(entry).toMatchObject({
      kind: 'refund',
      refund_id: id,
      amount: usd(150),
      unit_id: unit.id,
      capture_id: unit.capture_id,
      environment: 'dryrun',
    });
    expect(entry.ref_entry_id).not.toBeNull();
    const receipt = ReceiptSchema.parse(
      await getReceiptForBuyer(w.db, { order_id: a.order_id, buyer_id: 'buy_A' }),
    );
    expect(receipt.version).toBe(2);
    expect(receipt.refunds).toEqual([{ refund_id: id, amount: usd(150), at: entry.created_at }]);
  });

  it('the refund list the adapter hands over is an OrderReadUnit with refunds the booking can read', async () => {
    const { a, unit } = await setup();
    w.dashboard(unit.capture_id, 150, 'PENDING');
    const provider = (
      await w.rows<{ provider_order_id: string }>(
        'SELECT provider_order_id FROM provider_orders WHERE order_id = $1',
        [a.order_id],
      )
    )[0]!.provider_order_id;
    const read = await w.paypal.getOrder(provider);
    if (read.kind !== 'order') throw new Error('no order');
    const parsed = OrderReadUnitSchema.parse(read.units[0]);
    expect(parsed.refunds).toEqual([
      { refund_id: expect.any(String), status: 'PENDING', amount: usd(150) },
    ]);
  });

  it('the alert of an inconsistent list is a frozen_order with a primitive detail and no amounts of the buyer', async () => {
    const { a, unit } = await setup();
    const provider = (
      await w.rows<{ provider_order_id: string }>('SELECT provider_order_id FROM provider_orders')
    )[0]!.provider_order_id;
    await w.editNextRead(provider, (r) => ({
      ...r,
      units: r.units.map((u) => ({
        ...u,
        refunds: [
          { refund_id: 'RFEUR', status: 'COMPLETED', amount: { currency: 'EUR', minor: 100 } },
        ],
      })),
    }));
    await reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'poll' });
    const alerts = await w.rows<{
      kind: string;
      order_id: string;
      unit_id: string;
      detail: Record<string, unknown>;
    }>('SELECT kind, order_id, unit_id, detail FROM alerts WHERE order_id = $1', [a.order_id]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'frozen_order',
      order_id: a.order_id,
      unit_id: unit.id,
    });
    for (const v of Object.values(alerts[0]!.detail)) {
      expect(['string', 'number', 'boolean']).toContain(typeof v);
    }
    expect(alerts[0]!.detail['reason']).toBe('refund_list_currency_RFEUR');
  });
});
