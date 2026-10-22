import { describe, expect, it } from 'vitest';
import { CaseKindSchema, CaseStateSchema, CaseViewSchema } from './recovery';

describe('recovery', () => {
  it('CaseView and enums', () => {
    const c = {
      case_id: 'cas_1',
      kind: 'delivery_failed',
      state: 'open',
      order_id: 'ord_1',
      entitlement_id: null,
      opened_by: 'system',
      opened_at: '2026-10-21T10:00:00Z',
      buyer_message: 'm',
      credit_ms: 0,
    };
    expect(CaseViewSchema.safeParse(c).success).toBe(true);
    expect(CaseViewSchema.safeParse({ ...c, state: 'lost' }).success).toBe(false);
    expect(CaseKindSchema.options).toHaveLength(6);
    expect(CaseStateSchema.options).toHaveLength(8);
  });
});
