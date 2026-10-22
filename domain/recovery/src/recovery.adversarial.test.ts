import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordDeliveryEvent } from '@umsbx/access-clock';
import { applyAutomaticRules, diagnose, listCasesForBuyer, openCase, resolve } from './index';
import { HOUR, makeWorld } from './world';
import type { World } from './world';

const buyer1 = { kind: 'buyer', buyer_id: 'buy_1' } as const;
const buyer2 = { kind: 'buyer', buyer_id: 'buy_2' } as const;
const operator = { kind: 'operator', operator_id: 'opr_1', mfa: true } as const;

let w: World;
beforeAll(async () => {
  w = await makeWorld('adv');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
});

describe("buyer B and buyer A's cases (P13, A-20)", () => {
  it('cannot see, open or act on them', async () => {
    const a = await w.item(1, { buyer_id: 'buy_1' });
    const opened = await openCase(w.deps, {
      kind: 'delivery_failed',
      entitlement_id: a.entitlement_id,
      opened_by: 'buyer',
      actor: buyer1,
    });
    if (!opened.ok) throw new Error('open failed');

    // See: B's list is empty and A's list holds the case.
    expect(await listCasesForBuyer(w.db, { buyer_id: 'buy_2' })).toEqual([]);
    expect(await listCasesForBuyer(w.db, { buyer_id: 'buy_1' })).toHaveLength(1);

    // Open: B naming A's item or order gets exactly the answer for an id that does not exist.
    const probe = (entitlement_id: string, order_id?: string) =>
      openCase(w.deps, {
        kind: 'refund_requested',
        entitlement_id,
        ...(order_id !== undefined ? { order_id } : {}),
        opened_by: 'buyer',
        actor: buyer2,
      });
    const real = await probe(a.entitlement_id);
    const unknown = await probe('ent_unknown');
    expect(real).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(unknown).toEqual(real);
    expect(
      await openCase(w.deps, {
        kind: 'payment_unresolved',
        order_id: a.order_id,
        opened_by: 'buyer',
        actor: buyer2,
      }),
    ).toEqual(real);
    // Even a duplicate kind answers not_found, never duplicate_open (no existence oracle).
    const dup = await openCase(w.deps, {
      kind: 'delivery_failed',
      entitlement_id: a.entitlement_id,
      opened_by: 'buyer',
      actor: buyer2,
    });
    expect(dup).toEqual(real);

    // Act: every resolve by a buyer is not_operator, for A's case, B's guess and an unknown id.
    for (const case_id of [opened.value.case_id, 'cas_unknown']) {
      for (const action of [
        'restore',
        'credit',
        'close_not_charged',
        'offer_refund',
        'close_no_fault',
      ] as const) {
        expect(
          await resolve(w.deps, { case_id, action, credit_ms: HOUR, by: buyer2, reason: 'x' }),
        ).toEqual({ ok: false, error: { code: 'not_operator' } });
      }
    }
    expect(await w.count('recovery_cases')).toBe(1);
    expect((await listCasesForBuyer(w.db, { buyer_id: 'buy_1' }))[0]?.state).toBe('open');
    expect(await w.count('recovery_actions')).toBe(1);
  });

  it('a publisher or a non-buyer actor cannot open a buyer-reported case', async () => {
    const a = await w.item(1);
    for (const actor of [
      { kind: 'publisher', publisher_id: 'pub_1' },
      { kind: 'system' },
    ] as const) {
      const r = await openCase(w.deps, {
        kind: 'delivery_failed',
        entitlement_id: a.entitlement_id,
        opened_by: 'buyer',
        actor,
      });
      expect(r.ok).toBe(false);
    }
    expect(await w.count('recovery_cases')).toBe(0);
  });

  it('malformed ids name nothing and throw nothing', async () => {
    for (const bad of ['', ' x', 'a\u0000b', 'x'.repeat(201)]) {
      const r = await openCase(w.deps, {
        kind: 'delivery_failed',
        entitlement_id: bad,
        opened_by: 'buyer',
        actor: buyer1,
      });
      expect(r).toEqual({ ok: false, error: { code: 'not_found' } });
    }
    expect(await listCasesForBuyer(w.db, { buyer_id: 'a\u0000b' })).toEqual([]);
    expect(await diagnose(w.deps, { case_id: 'a\u0000b' })).toEqual({
      evidence: [],
      window: null,
      order_status: null,
    });
  });

  it('keeps a hostile note as inert text', async () => {
    const a = await w.item(1);
    const note = "'); DROP TABLE recovery_cases; --";
    const r = await openCase(w.deps, {
      kind: 'delivery_failed',
      entitlement_id: a.entitlement_id,
      opened_by: 'buyer',
      actor: buyer1,
      note,
    });
    expect(r.ok).toBe(true);
    expect(await w.count('recovery_cases')).toBe(1);
    const stored = await w.db.query<{ detail: { note?: string } }>(
      "SELECT detail FROM recovery_actions WHERE action = 'opened'",
    );
    expect(stored.rows[0]?.detail.note).toBe(note);
  });
});

describe('recovery never moves money', () => {
  it('restore never creates an order, approval or ledger row', async () => {
    const a = await w.item(1);
    await recordDeliveryEvent(w.deps, {
      entitlement_id: a.entitlement_id,
      kind: 'delivery_failed',
      link_id: null,
      source: 'system',
      evidence: {},
    });
    await w.rawAlert({ kind: 'frozen_order', order_id: a.order_id });
    const tables = [
      'orders',
      'order_units',
      'approvals',
      'ledger_entries',
      'refund_requests',
      'provider_orders',
      'provider_calls',
      'operations',
      'receipts',
      'entitlements',
    ];
    const snapshot = async () => Promise.all(tables.map((t) => w.count(t)));
    const before = await snapshot();
    await applyAutomaticRules(w.deps, { max_items: 10 });
    w.clock.advance(3 * HOUR);
    for (const c of await listCasesForBuyer(w.db, { buyer_id: 'buy_1' })) {
      await resolve(w.deps, {
        case_id: c.case_id,
        action: 'restore',
        by: operator,
        reason: 'fixed',
      });
    }
    await resolve(w.deps, { case_id: 'cas_unknown', action: 'restore', by: operator, reason: 'x' });
    expect(await snapshot()).toEqual(before);
    const orders = await w.db.query<{ status: string }>('SELECT status FROM orders');
    expect(orders.rows).toEqual([{ status: 'paid' }]);
  });

  it('close_not_charged refuses every verified-capture unit status', async () => {
    let n = 0;
    for (const unit_status of [
      'captured_verified',
      'partially_refunded',
      'refunded',
      'reversal_suspected',
      'reversed',
    ]) {
      n += 1;
      const x = await w.item(n, { unit_status });
      const c = await openCase(w.deps, {
        kind: 'payment_unresolved',
        order_id: x.order_id,
        opened_by: 'system',
        actor: { kind: 'system' },
      });
      if (!c.ok) throw new Error('open failed');
      expect(
        await resolve(w.deps, {
          case_id: c.value.case_id,
          action: 'close_not_charged',
          by: operator,
          reason: 'x',
        }),
      ).toEqual({ ok: false, error: { code: 'wrong_state' } });
    }
  });

  it('a case on an unpaid order is never restored into a link', async () => {
    const x = await w.item(1, { unit_status: 'pending' });
    const c = await openCase(w.deps, {
      kind: 'payment_unresolved',
      order_id: x.order_id,
      opened_by: 'system',
      actor: { kind: 'system' },
    });
    if (!c.ok) throw new Error('open failed');
    const r = await resolve(w.deps, {
      case_id: c.value.case_id,
      action: 'restore',
      by: operator,
      reason: 'x',
    });
    expect(r).toEqual({ ok: false, error: { code: 'wrong_state' } });
    expect(await w.count('links')).toBe(0);
  });
});
