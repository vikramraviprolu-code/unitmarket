// BR-1: the rules registry and its schemas. Shapes and the table of defaults only; the resolver is
// tested in domain/rules.
import { describe, expect, it } from 'vitest';
import {
  ResolvedTermsSchema,
  RULES_REGISTRY,
  RULE_KEYS,
  RuleKeySchema,
  RuleScopeKindSchema,
  RuleSettingRowSchema,
  isRuleValueInRange,
} from './rules';

const row = {
  id: 'rul_1',
  rule_key: 'refund.request_window',
  scope_kind: 'platform',
  scope_id: null,
  value: 7,
  effective_from: '2026-11-05T00:00:00.000Z',
  effective_until: null,
  set_by: 'op_1',
  reason: 'D-096 default window',
  approved_by: null,
  created_at: '2026-11-05T00:00:00.000Z',
};

describe('RULES_REGISTRY', () => {
  it('holds the three slice keys and nothing else', () => {
    expect([...RULE_KEYS].sort()).toEqual([
      'access.window',
      'mandate.max_days',
      'refund.request_window',
    ]);
    expect(Object.keys(RULES_REGISTRY).sort()).toEqual([...RULE_KEYS].sort());
  });

  it('matches the BR-1 table', () => {
    expect(RULES_REGISTRY['refund.request_window']).toMatchObject({
      default: 7,
      min: 0,
      max: 30,
      merge: 'max',
      tier: 'A',
      scopes: ['platform', 'category', 'seller', 'buyer', 'agreement'],
    });
    expect(RULES_REGISTRY['access.window']).toMatchObject({
      default: 5,
      min: 1,
      max: 30,
      merge: 'seller_wins',
      tier: 'A',
      scopes: ['platform', 'category', 'seller'],
    });
    expect(RULES_REGISTRY['mandate.max_days']).toMatchObject({
      default: 90,
      min: 1,
      max: 90,
      merge: 'min',
      tier: 'A',
      scopes: ['platform', 'buyer'],
    });
  });

  it('is frozen, entries and scope lists included', () => {
    expect(Object.isFrozen(RULES_REGISTRY)).toBe(true);
    for (const key of RULE_KEYS) {
      expect(Object.isFrozen(RULES_REGISTRY[key])).toBe(true);
      expect(Object.isFrozen(RULES_REGISTRY[key].scopes)).toBe(true);
    }
  });

  it('keeps every default inside its own safe range and scope list', () => {
    for (const key of RULE_KEYS) {
      const def = RULES_REGISTRY[key];
      expect(Number.isInteger(def.default)).toBe(true);
      expect(def.default).toBeGreaterThanOrEqual(def.min);
      expect(def.default).toBeLessThanOrEqual(def.max);
      expect(def.scopes).toContain('platform');
      for (const scope of def.scopes)
        expect(RuleScopeKindSchema.safeParse(scope).success).toBe(true);
    }
  });

  it('isRuleValueInRange follows the registry and refuses non-integers', () => {
    expect(isRuleValueInRange('refund.request_window', 0)).toBe(true);
    expect(isRuleValueInRange('refund.request_window', 30)).toBe(true);
    expect(isRuleValueInRange('refund.request_window', 31)).toBe(false);
    expect(isRuleValueInRange('refund.request_window', -1)).toBe(false);
    expect(isRuleValueInRange('access.window', 0)).toBe(false);
    expect(isRuleValueInRange('mandate.max_days', 91)).toBe(false);
    expect(isRuleValueInRange('mandate.max_days', 2.5)).toBe(false);
    expect(isRuleValueInRange('mandate.max_days', Number.NaN)).toBe(false);
  });
});

describe('RuleKeySchema and RuleScopeKindSchema', () => {
  it('accept only registry keys and the five scopes', () => {
    expect(RuleKeySchema.safeParse('refund.request_window').success).toBe(true);
    expect(RuleKeySchema.safeParse('fee.platform_rate_bps').success).toBe(false);
    for (const s of ['platform', 'category', 'seller', 'buyer', 'agreement']) {
      expect(RuleScopeKindSchema.safeParse(s).success).toBe(true);
    }
    expect(RuleScopeKindSchema.safeParse('offer').success).toBe(false);
  });
});

describe('RuleSettingRowSchema', () => {
  it('accepts a platform row and a seller row', () => {
    expect(RuleSettingRowSchema.safeParse(row).success).toBe(true);
    expect(
      RuleSettingRowSchema.safeParse({
        ...row,
        scope_kind: 'seller',
        scope_id: 'pub_1',
        effective_until: '2027-01-01T00:00:00.000Z',
        approved_by: 'op_2',
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown rule key', () => {
    expect(
      RuleSettingRowSchema.safeParse({ ...row, rule_key: 'fee.platform_rate_bps' }).success,
    ).toBe(false);
  });

  it('refuses an unknown field (strict)', () => {
    expect(RuleSettingRowSchema.safeParse({ ...row, extra: 1 }).success).toBe(false);
  });

  it('refuses a scope kind outside the five', () => {
    expect(
      RuleSettingRowSchema.safeParse({ ...row, scope_kind: 'offer', scope_id: 'x' }).success,
    ).toBe(false);
  });

  it('refuses a scope the key does not allow', () => {
    const r = RuleSettingRowSchema.safeParse({
      ...row,
      rule_key: 'mandate.max_days',
      scope_kind: 'seller',
      scope_id: 'pub_1',
      value: 30,
    });
    expect(r.success).toBe(false);
    expect(
      RuleSettingRowSchema.safeParse({
        ...row,
        rule_key: 'access.window',
        scope_kind: 'buyer',
        scope_id: 'buy_1',
        value: 10,
      }).success,
    ).toBe(false);
  });

  it('allows a null scope_id only for platform', () => {
    expect(RuleSettingRowSchema.safeParse({ ...row, scope_id: 'x' }).success).toBe(false);
    expect(
      RuleSettingRowSchema.safeParse({ ...row, scope_kind: 'seller', scope_id: null }).success,
    ).toBe(false);
    expect(
      RuleSettingRowSchema.safeParse({ ...row, scope_kind: 'category', scope_id: null }).success,
    ).toBe(false);
  });

  it('holds reason to 3..200 characters', () => {
    expect(RuleSettingRowSchema.safeParse({ ...row, reason: 'ab' }).success).toBe(false);
    expect(RuleSettingRowSchema.safeParse({ ...row, reason: 'abc' }).success).toBe(true);
    expect(RuleSettingRowSchema.safeParse({ ...row, reason: 'x'.repeat(200) }).success).toBe(true);
    expect(RuleSettingRowSchema.safeParse({ ...row, reason: 'x'.repeat(201) }).success).toBe(false);
  });

  it('wants an integer value and ISO UTC times', () => {
    expect(RuleSettingRowSchema.safeParse({ ...row, value: 7.5 }).success).toBe(false);
    expect(RuleSettingRowSchema.safeParse({ ...row, value: '7' }).success).toBe(false);
    expect(RuleSettingRowSchema.safeParse({ ...row, effective_from: 'yesterday' }).success).toBe(
      false,
    );
    expect(
      RuleSettingRowSchema.safeParse({ ...row, created_at: '2026-11-05T00:00:00+01:00' }).success,
    ).toBe(false);
  });
});

describe('ResolvedTermsSchema', () => {
  const good = {
    rules_version: '1',
    values: { 'refund.request_window': 7, 'access.window': 7, 'mandate.max_days': 90 },
    sources: {
      'refund.request_window': 'default',
      'access.window': 'linked:refund.request_window',
      'mandate.max_days': 'default',
    },
    digest: 'a'.repeat(64),
  };

  it('accepts the resolver output shape', () => {
    expect(ResolvedTermsSchema.safeParse(good).success).toBe(true);
  });

  it('is named rules_version, not terms_version, and is pinned to "1"', () => {
    expect(ResolvedTermsSchema.safeParse({ ...good, rules_version: '2' }).success).toBe(false);
    const swapped: Record<string, unknown> = { ...good, terms_version: '1' };
    delete swapped.rules_version;
    expect(ResolvedTermsSchema.safeParse(swapped).success).toBe(false);
  });

  it('refuses an extra or missing key, and a bad digest', () => {
    expect(
      ResolvedTermsSchema.safeParse({
        ...good,
        values: { ...good.values, 'fee.platform_rate_bps': 1000 },
      }).success,
    ).toBe(false);
    expect(
      ResolvedTermsSchema.safeParse({
        ...good,
        values: { 'refund.request_window': 7, 'access.window': 7 },
      }).success,
    ).toBe(false);
    expect(ResolvedTermsSchema.safeParse({ ...good, digest: 'ABC' }).success).toBe(false);
  });

  it('holds each source to 1..500 characters', () => {
    const withSource = (text: string) => ({
      ...good,
      sources: { ...good.sources, 'mandate.max_days': text },
    });
    expect(ResolvedTermsSchema.safeParse(withSource('')).success).toBe(false);
    expect(ResolvedTermsSchema.safeParse(withSource('x')).success).toBe(true);
    expect(ResolvedTermsSchema.safeParse(withSource('x'.repeat(500))).success).toBe(true);
    expect(ResolvedTermsSchema.safeParse(withSource('x'.repeat(501))).success).toBe(false);
    for (const key of ['refund.request_window', 'access.window'] as const) {
      const bad = { ...good, sources: { ...good.sources, [key]: '' } };
      expect(ResolvedTermsSchema.safeParse(bad).success).toBe(false);
      const long = { ...good, sources: { ...good.sources, [key]: 'x'.repeat(501) } };
      expect(ResolvedTermsSchema.safeParse(long).success).toBe(false);
    }
  });
});
