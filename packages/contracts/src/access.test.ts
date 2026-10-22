import { describe, expect, it } from 'vitest';
import {
  AccessEventKindSchema,
  AccessEventSchema,
  WindowStateNameSchema,
  WindowStateSchema,
} from './access';

describe('access', () => {
  it('WindowState', () => {
    const w = {
      state: 'running',
      started_at: '2026-10-21T10:00:00Z',
      base_ends_at: '2026-10-26T10:00:00Z',
      ends_at: '2026-10-26T10:00:00Z',
      paused_at: null,
      credit_ms: 0,
    };
    expect(WindowStateSchema.safeParse(w).success).toBe(true);
    expect(WindowStateSchema.safeParse({ ...w, credit_ms: -1 }).success).toBe(false);
    expect(WindowStateSchema.safeParse({ ...w, state: 'frozen' }).success).toBe(false);
    expect(WindowStateNameSchema.options).toHaveLength(5);
  });
  it('AccessEvent', () => {
    const e = {
      entitlement_id: 'ent_1',
      kind: 'access_ready',
      at: '2026-10-21T10:00:00Z',
      source: 'system',
      evidence: { n: 1, s: 'x', b: true, z: null },
    };
    expect(AccessEventSchema.safeParse(e).success).toBe(true);
    expect(AccessEventSchema.safeParse({ ...e, source: 'robot' }).success).toBe(false);
    expect(AccessEventSchema.safeParse({ ...e, evidence: { o: {} } }).success).toBe(false);
    expect(AccessEventKindSchema.options).toHaveLength(11);
  });
});
