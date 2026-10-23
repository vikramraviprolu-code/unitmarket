import { describe, expect, it } from 'vitest';
import { DomainConfigSchema } from './config';

const secret = (v: string) => ({
  reveal: () => v,
  toString: () => '[redacted]' as const,
  toJSON: () => '[redacted]' as const,
});
const cfg = {
  reconcile_window_ms: 86400000,
  reconcile_backoff_ms: [30000, 120000, 600000, 3600000],
  idem_safe_window_ms: 18000000,
  abandoned_checkout_ms: 86400000,
  operation_lease_ms: 60000,
  max_capture_retries: 1,
  link_ttl_ms: 600000,
  public_origin: 'https://example.test',
  approval_secret: secret('x'),
  link_secret: secret('y'),
  rule_version: 'r1',
  pricing_rule_version: 'p1',
};
describe('DomainConfig', () => {
  it('accepts the documented defaults', () => {
    expect(DomainConfigSchema.safeParse(cfg).success).toBe(true);
    expect(
      DomainConfigSchema.safeParse({ ...cfg, public_origin: 'http://localhost:3000' }).success,
    ).toBe(true);
  });
  it('refuses a non-https public origin other than localhost, and paths', () => {
    expect(
      DomainConfigSchema.safeParse({ ...cfg, public_origin: 'http://example.test' }).success,
    ).toBe(false);
    expect(
      DomainConfigSchema.safeParse({ ...cfg, public_origin: 'https://example.test/path' }).success,
    ).toBe(false);
    expect(
      DomainConfigSchema.safeParse({ ...cfg, public_origin: 'http://localhost.evil.test' }).success,
    ).toBe(false);
  });
  it('refuses a plain string secret and negative durations', () => {
    expect(DomainConfigSchema.safeParse({ ...cfg, approval_secret: 'plain' }).success).toBe(false);
    expect(DomainConfigSchema.safeParse({ ...cfg, link_ttl_ms: -1 }).success).toBe(false);
    expect(DomainConfigSchema.safeParse({ ...cfg, reconcile_backoff_ms: [] }).success).toBe(false);
  });

  it('M3: idem_safe_window_ms stays under the 6 h PayPal key retention; max_capture_retries is at most 1', () => {
    const ok = (o: object) => DomainConfigSchema.safeParse({ ...cfg, ...o }).success;
    expect(ok({ idem_safe_window_ms: 18_000_000 })).toBe(true);
    expect(ok({ idem_safe_window_ms: 18_000_001 })).toBe(false);
    expect(ok({ idem_safe_window_ms: 21_600_000 })).toBe(false);
    expect(ok({ max_capture_retries: 1 })).toBe(true);
    expect(ok({ max_capture_retries: 0 })).toBe(true);
    expect(ok({ max_capture_retries: 2 })).toBe(false);
  });
  it('L4: public_origin refuses userinfo, query, fragment and an empty host', () => {
    const ok = (o: string) => DomainConfigSchema.safeParse({ ...cfg, public_origin: o }).success;
    expect(ok('https://example.test')).toBe(true);
    expect(ok('https://example.test:8443')).toBe(true);
    expect(ok('http://localhost:3000')).toBe(true);
    for (const bad of [
      'https://user@example.test',
      'https://user:pw@example.test',
      'https://example.test?x=1',
      'https://example.test#frag',
      'https://example.test/',
      'https://',
      'https://example.test:99999999',
      'http://localhost@evil.test',
      'http://localhost?x=1',
    ]) {
      expect(ok(bad), bad).toBe(false);
    }
  });
  it('BU-5: the poll budget fields are optional (older configs stay valid) and keep their documented values', () => {
    const parsed = DomainConfigSchema.safeParse({
      ...cfg,
      poll_budget_share: 0.5,
      capture_reserve_calls: 30,
      reread_paid_every_ms: 21_600_000,
      min_call_gap_ms: 500,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.poll_budget_share).toBe(0.5);
      expect(parsed.data.capture_reserve_calls).toBe(30);
      expect(parsed.data.reread_paid_every_ms).toBe(21_600_000);
      expect(parsed.data.min_call_gap_ms).toBe(500);
    }
    // absent: no default is invented here, the consumers apply theirs
    const bare = DomainConfigSchema.safeParse(cfg);
    expect(bare.success).toBe(true);
    if (bare.success) expect(bare.data.poll_budget_share).toBeUndefined();
  });
  it('BU-5: the poll budget fields refuse values that would starve or flood the budget', () => {
    const ok = (o: object) => DomainConfigSchema.safeParse({ ...cfg, ...o }).success;
    expect(ok({ poll_budget_share: 0 })).toBe(true);
    expect(ok({ poll_budget_share: 1 })).toBe(true);
    expect(ok({ poll_budget_share: 1.01 })).toBe(false);
    expect(ok({ poll_budget_share: -0.1 })).toBe(false);
    expect(ok({ poll_budget_share: Number.NaN })).toBe(false);
    expect(ok({ capture_reserve_calls: 0 })).toBe(true);
    expect(ok({ capture_reserve_calls: -1 })).toBe(false);
    expect(ok({ capture_reserve_calls: 1.5 })).toBe(false);
    expect(ok({ reread_paid_every_ms: 3_600_000 })).toBe(true);
    expect(ok({ reread_paid_every_ms: 0 })).toBe(false);
    expect(ok({ reread_paid_every_ms: -1 })).toBe(false);
    expect(ok({ min_call_gap_ms: 0 })).toBe(true);
    expect(ok({ min_call_gap_ms: -1 })).toBe(false);
  });
});
