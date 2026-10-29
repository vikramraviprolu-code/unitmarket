// MVP-D offline acceptance D-06 and D-07 (mvp-plan MVP-D table; nfr.md P11 per publisher).
// D-06: the per-publisher ledger invariant (INV7) holds after a happy pack, a partial pack and refunds
// of each publisher's unit, and a drifted row is named by publisher. D-07: a pack of two currencies is
// refused before any approval exists. Real routes and engine over the approved sandbox transport and a
// fake Wire playing the dry-run model; no byte leaves the process.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkInvariants } from '@umsbx/payments';
import { publisherBalances } from '@umsbx/ledger';
import {
  D042_OPERATIONS,
  HARBOUR_TIDE,
  NORTH_ALLOTMENT,
  QUAY_MARKET,
  bootDRig,
  fingerprint,
  orderStatus,
  postApproval,
  runPack,
} from './d-support';
import type { DRig } from './d-support';

vi.mock('server-only', () => ({}));

let rig: DRig;
afterEach(async () => {
  await rig?.close();
});

const report = async () => await checkInvariants(rig.app.db);
const failing = async (): Promise<string[]> =>
  (await report()).filter((i) => !i.ok).map((i) => `${i.id}: ${i.detail}`);

/** Net per publisher slug from the ledger, computed here with the ledger package's own sums. */
async function netBySlug(): Promise<Record<string, number>> {
  const rows = await rig.rows<{
    slug: string;
    publisher_id: string;
    id: string;
    unit_id: string;
    capture_id: string;
    kind: 'sale' | 'refund' | 'reversal' | 'paypal_fee';
    amount_minor: number | string;
    currency: string;
    refund_id: string | null;
    environment: 'dryrun' | 'sandbox';
  }>(
    `SELECT pub.slug, u.publisher_id, l.id, l.unit_id, l.capture_id, l.kind, l.amount_minor, l.currency,
            l.refund_id, l.environment
       FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id
       JOIN publishers pub ON pub.id = u.publisher_id`,
  );
  const slugOf = new Map(rows.map((r) => [r.publisher_id, r.slug]));
  const balances = publisherBalances(
    rows.map((r) => ({
      publisher_id: r.publisher_id,
      entry: {
        id: r.id,
        unit_id: r.unit_id,
        capture_id: r.capture_id,
        kind: r.kind,
        amount: { currency: r.currency, minor: Number(r.amount_minor) },
        refund_id: r.refund_id,
        ref_entry_id: null,
        created_at: '2026-10-29T00:00:00.000Z',
        environment: r.environment,
      },
    })),
  );
  return Object.fromEntries(balances.map((b) => [slugOf.get(b.publisher_id)!, b.net_minor]));
}

const priceOf = async (slug: string): Promise<number> =>
  Number(
    (
      await rig.rows<{ a: number | string }>(
        `SELECT u.amount_minor AS a FROM order_units u JOIN publishers p ON p.id = u.publisher_id WHERE p.slug = $1`,
        [slug],
      )
    )[0]!.a,
  );

describe('D-06 ledger_per_publisher', () => {
  it('D-06 after a happy pack each publisher holds its own sale and INV7 holds', async () => {
    rig = await bootDRig();
    await runPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET], ['happy', 'happy']);
    expect(await netBySlug()).toEqual({
      'harbour-ledger': await priceOf('harbour-ledger'),
      'quayside-gazette': await priceOf('quayside-gazette'),
    });
    const inv7 = (await report()).find((i) => i.id === 'INV7')!;
    expect(inv7.ok).toBe(true);
    expect(await failing()).toEqual([]);
  });

  it.each([
    ['the second PayPal order is declined', ['happy', 'declined']],
    ['the first PayPal order is declined', ['declined', 'happy']],
  ] as const)(
    'D-06 after a partial pack (%s) only the captured publisher has a balance and INV7 holds',
    async (_n, scenarios) => {
      rig = await bootDRig();
      const run = await runPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET], [...scenarios]);
      expect(await orderStatus(rig, run.order_id)).toBe('paid_partial');
      const net = await netBySlug();
      expect(Object.keys(net).length).toBe(1);
      const slug = Object.keys(net)[0]!;
      expect(net[slug]).toBe(await priceOf(slug));
      expect((await report()).find((i) => i.id === 'INV7')!.ok).toBe(true);
      expect(await failing()).toEqual([]);
    },
  );

  it('D-06 after a partial refund of one publisher and a full refund of the other, each balance is its price minus its refunds and INV7 holds', async () => {
    rig = await bootDRig({ operations: [...D042_OPERATIONS, 'refund_capture', 'get_refund'] });
    await runPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET], ['happy', 'happy']);
    const op = { kind: 'operator' as const, operator_id: 'opr_vikram', mfa: true };
    const unit = async (slug: string) =>
      (
        await rig.rows<{ id: string }>(
          `SELECT u.id FROM order_units u JOIN publishers p ON p.id = u.publisher_id WHERE p.slug = $1`,
          [slug],
        )
      )[0]!.id;
    const harbourPrice = await priceOf('harbour-ledger');
    const quaysidePrice = await priceOf('quayside-gazette');

    const part = await rig.app.engine.refund.request({
      actor: op,
      unit_id: await unit('harbour-ledger'),
      amount_minor: 10,
      reason: 'D-06 part of the harbour item',
    });
    expect(part.ok).toBe(true);
    expect(await netBySlug()).toEqual({
      'harbour-ledger': harbourPrice - 10,
      'quayside-gazette': quaysidePrice,
    });
    expect(await failing()).toEqual([]);

    const full = await rig.app.engine.refund.request({
      actor: op,
      unit_id: await unit('quayside-gazette'),
      amount_minor: null,
      reason: 'D-06 all of the quayside item',
    });
    expect(full.ok).toBe(true);
    expect(await netBySlug()).toEqual({
      'harbour-ledger': harbourPrice - 10,
      'quayside-gazette': 0,
    });
    expect(await failing()).toEqual([]);
    expect(rig.calls('refund_capture')).toBe(2);
  });

  it('D-06 a ledger row injected on one publisher is named in the INV7 report with its difference (the check can fail)', async () => {
    rig = await bootDRig();
    const run = await runPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET], ['happy', 'declined']);
    expect(await orderStatus(rig, run.order_id)).toBe('paid_partial');
    // The declined unit is never booked; a hand-written sale on it is drift that INV7 must name.
    const bad = (
      await rig.rows<{ id: string; publisher_id: string; capture_id: string | null }>(
        `SELECT id, publisher_id, capture_id FROM order_units WHERE status = 'declined'`,
      )
    )[0]!;
    await rig.rows(
      `INSERT INTO ledger_entries (id, unit_id, capture_id, kind, amount_minor, currency, refund_id, ref_entry_id, environment, created_at, updated_at)
       SELECT 'led_dp6_drift', u.id, $2, 'sale', 77, o.currency, NULL, NULL, o.environment, now(), now()
         FROM order_units u JOIN orders o ON o.id = u.order_id WHERE u.id = $1`,
      [bad.id, bad.capture_id ?? 'FAKECAPDP6'],
    );
    const inv7 = (await report()).find((i) => i.id === 'INV7')!;
    expect(inv7.ok).toBe(false);
    expect(inv7.detail).toContain(bad.publisher_id);
    expect(inv7.detail).toContain('difference 77');
  });
});

describe('D-07 mixed_currency', () => {
  it.each([
    ['USD item first', [HARBOUR_TIDE, NORTH_ALLOTMENT]],
    ['GBP item first', [NORTH_ALLOTMENT, HARBOUR_TIDE]],
  ] as const)(
    'D-07 a pack of USD and GBP items (%s) is refused before approval: 422 mixed_currency, no approval, no order, no PayPal call',
    async (_name, offers) => {
      rig = await bootDRig();
      const before = await fingerprint(rig);
      const res = await postApproval(rig, 'A', offers);
      expect(res.status).toBe(422);
      const err = res.body['error'] as { code: string; message: string };
      expect(err.code).toBe('mixed_currency');
      expect(err.message).toMatch(/different currencies/);
      expect(await rig.count('SELECT count(*) AS c FROM approvals')).toBe(0);
      expect(await rig.count('SELECT count(*) AS c FROM orders')).toBe(0);
      expect(rig.played).toEqual([]);
      const after = await fingerprint(rig);
      for (const t of [
        'orders',
        'order_units',
        'provider_orders',
        'ledger_entries',
        'approvals',
      ] as const)
        expect(after[t], t).toBe(before[t]);
    },
  );

  it('D-07 the refusal comes with the second publisher verified too (it is the currency, not the payee)', async () => {
    rig = await bootDRig();
    await rig.rows(
      `UPDATE publishers SET paypal_merchant_id = 'SBXDPSIXNOR01', payee_verified_at = now() WHERE slug = 'northfield-quarterly'`,
    );
    const res = await postApproval(rig, 'B', [HARBOUR_TIDE, NORTH_ALLOTMENT]);
    expect(res.status).toBe(422);
    expect((res.body['error'] as { code: string }).code).toBe('mixed_currency');
    expect(await rig.count('SELECT count(*) AS c FROM approvals')).toBe(0);
  });
});
