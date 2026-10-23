// CO-5 (ASM-59) contract: the entitlement surface CO-4 calls keeps its shape; the new money event
// is additive (type-level in packages/contracts/src/entitlements.ts) and the original schema is intact.
import { describe, expect, it } from 'vitest';
import { MoneyEventSchema, MoneyStateSchema } from '@umsbx/contracts';
import * as api from './index';
import { nextMoneyState } from './table';

describe('@umsbx/entitlements public surface', () => {
  it('exports exactly the same names as before CO-5', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'PACKAGE_NAME',
        'applyMoneyEvent',
        'createPendingEntitlements',
        'getEntitlementForBuyer',
        'nextMoneyState',
      ].sort(),
    );
    expect(api.applyMoneyEvent.length).toBe(3);
  });

  it('the money states and the payments-facing money events are unchanged', () => {
    expect(MoneyStateSchema.options).toEqual([
      'pending',
      'captured',
      'denied',
      'refunded',
      'reversed',
      'unknown',
    ]);
    expect(MoneyEventSchema.options).toHaveLength(6);
    expect(MoneyEventSchema.options).not.toContain('partial_refund_verified');
  });

  it('nextMoneyState answers the new event with an allowed no-op for every money state', () => {
    for (const m of MoneyStateSchema.options) {
      expect(nextMoneyState(m, 'partial_refund_verified'), m).toBe('=');
    }
  });
});
