// Adversarial: P13 cross-buyer reads and the database invariant.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPendingEntitlements, getEntitlementForBuyer } from './index';
import { makeWorld, policyFor } from './world';
import type { World } from './world';

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

describe('entitlement access control and invariants', () => {
  it("buyer B gets null for buyer A's entitlement (P13)", async () => {
    const { article_id, unit_id } = await w.supply(1);
    const [id] = await createPendingEntitlements(w.db, w.deps, {
      buyer_id: 'buy_1', unit_id, items: [{ article_id, option: 'keep_retrieve', policy: policyFor('keep_retrieve') }],
    });
    expect(await getEntitlementForBuyer(w.db, { entitlement_id: id!, buyer_id: 'buy_2' })).toBeNull();
    expect(await getEntitlementForBuyer(w.db, { entitlement_id: id!, buyer_id: 'buy_1' })).not.toBeNull();
    // Same answer as for an id that does not exist: no existence oracle.
    expect(await getEntitlementForBuyer(w.db, { entitlement_id: 'ent_missing', buyer_id: 'buy_2' })).toBeNull();
    expect(await getEntitlementForBuyer(w.db, { entitlement_id: 'ent_\u0000', buyer_id: 'buy_1' })).toBeNull();
  });

  it('direct UPDATE making access available without captured violates the CHECK', async () => {
    const { article_id, unit_id } = await w.supply(1);
    const [id] = await createPendingEntitlements(w.db, w.deps, {
      buyer_id: 'buy_1', unit_id, items: [{ article_id, option: 'keep_retrieve', policy: policyFor('keep_retrieve') }],
    });
    await expect(w.db.query("UPDATE entitlements SET access_state = 'available' WHERE id = $1", [id])).rejects.toThrow(/check|violates/i);
    const row = await w.db.query<{ access_state: string }>('SELECT access_state FROM entitlements WHERE id = $1', [id]);
    expect(row.rows[0]!.access_state).toBe('locked');
  });
});
