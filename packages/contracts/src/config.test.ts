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
});
