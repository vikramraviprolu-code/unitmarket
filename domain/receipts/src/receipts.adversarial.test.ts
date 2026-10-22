import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getReceiptForBuyer, issueReceiptIfChanged } from './index';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
beforeAll(async () => {
  w = await makeWorld('rct-adv');
});
afterAll(async () => {
  await w.close();
});

describe('receipts adversarial', () => {
  it("buyer B gets null for buyer A's receipt", async () => {
    const o = await w.order(1);
    const r = await w.db.transaction((tx) => issueReceiptIfChanged(tx, w.deps, { order_id: o.order_id }));
    expect(r.ok).toBe(true);
    expect(await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_B' })).toBeNull();
    expect(await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_B', version: 1 })).toBeNull();
    expect(await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_A' })).not.toBeNull();
  });

  it('unknown order, unknown version and hostile ids answer null', async () => {
    const o = await w.order(2);
    await w.db.transaction((tx) => issueReceiptIfChanged(tx, w.deps, { order_id: o.order_id }));
    expect(await getReceiptForBuyer(w.db, { order_id: 'ord_none', buyer_id: 'buy_A' })).toBeNull();
    expect(await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_A', version: 9 })).toBeNull();
    expect(await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: "buy_A' OR '1'='1" })).toBeNull();
    expect(await getReceiptForBuyer(w.db, { order_id: `${o.order_id}\u0000`, buyer_id: 'buy_A' })).toBeNull();
  });

  it('no receipt is issued for an unpaid order even when asked repeatedly', async () => {
    const o = await w.order(3, { captured: false });
    for (let i = 0; i < 3; i += 1) {
      const r = await w.db.transaction((tx) => issueReceiptIfChanged(tx, w.deps, { order_id: o.order_id }));
      expect(r).toEqual({ ok: false, error: { code: 'no_verified_capture' } });
    }
    expect(await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_A' })).toBeNull();
  });
});
