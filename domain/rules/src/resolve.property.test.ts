// BR-1 property: over 200 random row sets, resolveTerms keeps every value inside its safe range,
// keeps access >= refund, and answers the same for any row order. The generator is local and
// seeded, as in domain/access-clock/src/refund.property.test.ts (the testkit has no Rng).
import { describe, expect, it } from 'vitest';
import { RULES_REGISTRY, RULE_KEYS } from '@umsbx/contracts';
import type { RuleKey, RuleScopeKind, RuleSettingRow } from '@umsbx/contracts';
import { resolveTerms } from './index';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const DAY = 86_400_000;
const CTX = { seller_id: 'pub_1', buyer_id: 'buy_1', category: 'research' };
const SCOPE_IDS: Record<RuleScopeKind, string[]> = {
  platform: [],
  category: ['research', 'news'],
  seller: ['pub_1', 'pub_2'],
  buyer: ['buy_1', 'buy_2'],
  agreement: ['agr_1'],
};
const SCOPES: RuleScopeKind[] = ['platform', 'category', 'seller', 'buyer', 'agreement'];

describe('resolveTerms property, 200 random row sets', () => {
  it('values stay in range, access >= refund, order does not matter', () => {
    const next = rng(20261105);
    const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    const pick = <T>(list: readonly T[]): T => list[int(0, list.length - 1)] as T;

    for (let c = 0; c < 200; c += 1) {
      const rows: RuleSettingRow[] = [];
      const count = int(0, 14);
      for (let i = 0; i < count; i += 1) {
        const key: RuleKey = pick(RULE_KEYS);
        const def = RULES_REGISTRY[key];
        const kind = pick(SCOPES);
        const ids = SCOPE_IDS[kind];
        const from = NOW + int(-20, 5) * DAY + int(0, 3) * 1000;
        const until = next() < 0.4 ? new Date(from + int(1, 25) * DAY).toISOString() : null;
        rows.push({
          id: `rul_${c}_${i}`,
          rule_key: key,
          scope_kind: kind,
          scope_id: kind === 'platform' ? null : pick(ids),
          // Always inside the safe range: this property is about valid rows. The out-of-range
          // cases are the table tests.
          value: int(def.min, def.max),
          effective_from: new Date(from).toISOString(),
          effective_until: until,
          set_by: 'op_1',
          reason: 'property row',
          approved_by: null,
          created_at: new Date(from + int(0, 3) * 1000).toISOString(),
        });
      }

      const now = new Date(NOW).toISOString();
      const r = resolveTerms(CTX, rows, now);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;

      for (const key of RULE_KEYS) {
        const def = RULES_REGISTRY[key];
        const v = r.value.values[key];
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(def.min);
        expect(v).toBeLessThanOrEqual(def.max);
      }
      expect(r.value.values['access.window']).toBeGreaterThanOrEqual(
        r.value.values['refund.request_window'],
      );

      // Platform is a ceiling for the mandate: with an active platform mandate row, the resolved
      // value never exceeds the newest one. The expectation is computed here, not by resolve.ts.
      const live = rows
        .filter(
          (r) =>
            r.rule_key === 'mandate.max_days' &&
            r.scope_kind === 'platform' &&
            Date.parse(r.effective_from) <= NOW &&
            (r.effective_until === null || NOW < Date.parse(r.effective_until)),
        )
        .sort(
          (a, b) =>
            Date.parse(b.effective_from) - Date.parse(a.effective_from) ||
            Date.parse(b.created_at) - Date.parse(a.created_at) ||
            (a.id < b.id ? 1 : -1),
        );
      if (live[0] !== undefined) {
        expect(r.value.values['mandate.max_days']).toBeLessThanOrEqual(live[0].value);
      }

      // Any row order gives the same answer.
      const shuffled = [...rows];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = int(0, i);
        [shuffled[i], shuffled[j]] = [shuffled[j] as RuleSettingRow, shuffled[i] as RuleSettingRow];
      }
      expect(resolveTerms(CTX, shuffled, now)).toEqual(r);
    }
  });
});
