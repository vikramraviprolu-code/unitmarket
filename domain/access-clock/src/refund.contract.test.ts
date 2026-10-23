// CO-5 (ASM-59) contract: the public surface CO-4 calls does not change, and the contracts change
// is additive. Signatures, result codes, event vocabulary, the 5-day window and the credit rounding.
import { describe, expect, it } from 'vitest';
import { AccessEventKindSchema, AccessPolicySchema, MoneyEventSchema } from '@umsbx/contracts';
import * as api from './index';
import { policyFor } from './world';

describe('@umsbx/access-clock public surface (CO-4 calls these)', () => {
  it('exports exactly the same names as before CO-5', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'HOUR_MS',
        'MAX_CREDIT_MS',
        'PACKAGE_NAME',
        'ceilToHour',
        'computeWindow',
        'deriveAccessState',
        'grantCredit',
        'markAccessReady',
        'recordDeliveryEvent',
        'revokeWindow',
        'sweepWindows',
      ].sort(),
    );
  });

  it('keeps the argument counts of the writers', () => {
    expect(api.markAccessReady.length).toBe(3);
    expect(api.revokeWindow.length).toBe(3);
    expect(api.grantCredit.length).toBe(3);
    expect(api.recordDeliveryEvent.length).toBe(2);
    expect(api.sweepWindows.length).toBe(2);
    expect(api.computeWindow.length).toBe(3);
    expect(api.deriveAccessState.length).toBe(2);
  });
});

describe('the contracts change is additive', () => {
  it('no new access event kind: a partial refund writes no access event', () => {
    expect(AccessEventKindSchema.options).toEqual([
      'access_ready',
      'link_issued',
      'download_completed',
      'download_aborted',
      'reader_rendered',
      'reader_beacon',
      'delivery_failed',
      'delivery_restored',
      'credit_granted',
      'window_ended',
      'revoked',
    ]);
  });

  it('the payments-facing MoneyEventSchema keeps its six events', () => {
    expect(MoneyEventSchema.options).toEqual([
      'capture_verified',
      'pending',
      'declined',
      'unknown',
      'refund_verified',
      'reversal_verified',
    ]);
  });
});

describe('constants the spec says not to change', () => {
  it('the window is five days and the policy parses', () => {
    expect(AccessPolicySchema.parse(policyFor('keep_retrieve')).window_ms).toBe(432_000_000);
    expect(AccessPolicySchema.parse(policyFor('online_read')).window_ms).toBe(432_000_000);
  });

  it('credit rounds up to whole hours and is capped at a 32-bit total', () => {
    expect(api.HOUR_MS).toBe(3_600_000);
    expect(api.ceilToHour(1)).toBe(3_600_000);
    expect(api.ceilToHour(3_600_001)).toBe(7_200_000);
    expect(api.MAX_CREDIT_MS).toBe(2_147_483_647);
  });
});
