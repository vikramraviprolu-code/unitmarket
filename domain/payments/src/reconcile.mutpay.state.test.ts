// Mutation survivor of reconcile.ts (MUT-PAY): an unknown order is named in the error, not left to
// fail later on a null. Real PGlite.
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileOrder } from './index';
import { makeWorld } from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

describe('reconcileOrder', () => {
  it('an order that does not exist is an error that names it', async () => {
    w = await makeWorld();
    await expect(
      reconcileOrder(w.deps, { order_id: 'ord_missing', trigger: 'poll' }),
    ).rejects.toThrow('reconcileOrder: unknown order ord_missing');
    expect(w.paypal.calls).toHaveLength(0);
  });
});
