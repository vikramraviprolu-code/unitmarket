import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openCase } from '@umsbx/recovery';
import { getLibrary } from './index';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
beforeAll(async () => {
  w = await makeWorld('ladv');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
});

describe("buyer B and buyer A's library (P13, A-20)", () => {
  it('shows nothing of the other buyer: items, receipts, cases', async () => {
    const a = await w.item(1, { buyer_id: 'buy_1', title: 'A secret' });
    const b = await w.item(2, { buyer_id: 'buy_2', title: 'B own' });
    await w.insert('receipts', {
      id: 'rct_a',
      order_id: a.order_id,
      version: 1,
      body: '{}',
      sha256: '1'.repeat(64),
      environment: 'dryrun',
    });
    await openCase(w.deps, {
      kind: 'delivery_failed',
      entitlement_id: a.entitlement_id,
      opened_by: 'buyer',
      actor: { kind: 'buyer', buyer_id: 'buy_1' },
    });
    const forB = await getLibrary(w.db, { buyer_id: 'buy_2', now: w.clock.now() });
    expect(forB.map((i) => i.entitlement_id)).toEqual([b.entitlement_id]);
    expect(JSON.stringify(forB)).not.toContain('A secret');
    expect(forB[0]?.receipt_versions).toEqual([]);
    expect(forB[0]?.open_case).toBeNull();
    const forA = await getLibrary(w.db, { buyer_id: 'buy_1', now: w.clock.now() });
    expect(forA.map((i) => i.entitlement_id)).toEqual([a.entitlement_id]);
    expect(forA[0]?.receipt_versions).toEqual([1]);
    expect(forA[0]?.open_case?.kind).toBe('delivery_failed');
  });

  it('answers an unknown or malformed buyer id with an empty list', async () => {
    await w.item(1);
    for (const buyer_id of ['buy_unknown', '', ' buy_1', 'buy_1\u0000', 'x'.repeat(201)]) {
      expect(await getLibrary(w.db, { buyer_id, now: w.clock.now() })).toEqual([]);
    }
  });
});
