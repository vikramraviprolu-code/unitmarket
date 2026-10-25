// DP-1 (MVP-D): a composite approval (two publishers) is re-checked by placeOrder against the live
// publisher rows. This file only adds tests; no payments source changes. It lives here because
// domain/approval may not import payments (the dependency runs the other way).
import { afterEach, describe, expect, it } from 'vitest';
import { placeOrder } from './index';
import { BUYER_A, count, makeWorld } from './support';
import type { World } from './support';

let w: World;
afterEach(async () => {
  await w.close();
});

const place = (a: { approval_id: string; token: string }) =>
  placeOrder(w.deps, { approval_id: a.approval_id, token: a.token, actor: BUYER_A });

describe('composite: payee lost after approval', () => {
  it('payee lost after approval: placeOrder answers payee_unavailable for a composite', async () => {
    for (const [pub, set] of [
      ['pub_1', 'payee_verified_at = NULL'],
      ['pub_2', 'payee_verified_at = NULL'],
      ['pub_2', "paypal_merchant_id = 'OTHER'"],
      ['pub_1', 'paypal_merchant_id = NULL'],
    ] as const) {
      w = await makeWorld();
      const a = await w.approval({ offers: ['ofr_1', 'ofr_3'] });
      expect(a.snapshot.settlement).toEqual({ route: 'per_publisher', payments: 2 });
      await w.rows(`UPDATE publishers SET ${set} WHERE id = '${pub}'`);
      expect(await place(a)).toEqual({
        ok: false,
        error: { code: 'payee_unavailable', http: 409 },
      });
      expect(await count(w, 'orders')).toBe(0);
      expect(await count(w, 'order_units')).toBe(0);
      expect(await count(w, 'approvals', 'used_at IS NOT NULL')).toBe(0);
      await w.close();
    }
    w = await makeWorld();
  });

  it('with both payees intact the composite places one unit per publisher', async () => {
    w = await makeWorld();
    const a = await w.approval({ offers: ['ofr_1', 'ofr_3'] });
    const r = await place(a);
    expect(r.ok).toBe(true);
    expect(await count(w, 'order_units')).toBe(2);
  });
});
