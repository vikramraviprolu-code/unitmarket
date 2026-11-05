// BR-1: resolveTerms table cases. The expected side is written by hand from
// docs/specs/br-1-rules-registry.md and design section 6, not computed by resolve.ts.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RuleKey, RuleScopeKind, RuleSettingRow } from '@umsbx/contracts';
import { ResolvedTermsSchema } from '@umsbx/contracts';
import { resolveTerms } from './index';

const NOW = '2026-11-05T12:00:00.000Z';
const CTX = { seller_id: 'pub_1', buyer_id: 'buy_1', category: 'research' as string | null };

let n = 0;
function mk(
  rule_key: RuleKey,
  scope_kind: RuleScopeKind,
  scope_id: string | null,
  value: number,
  over: Partial<RuleSettingRow> = {},
): RuleSettingRow {
  n += 1;
  return {
    id: `rul_${String(n).padStart(3, '0')}`,
    rule_key,
    scope_kind,
    scope_id,
    value,
    effective_from: '2026-11-01T00:00:00.000Z',
    effective_until: null,
    set_by: 'op_1',
    reason: 'test row',
    approved_by: null,
    created_at: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}
const refund = (
  kind: RuleScopeKind,
  id: string | null,
  v: number,
  over: Partial<RuleSettingRow> = {},
) => mk('refund.request_window', kind, id, v, over);
const access = (
  kind: RuleScopeKind,
  id: string | null,
  v: number,
  over: Partial<RuleSettingRow> = {},
) => mk('access.window', kind, id, v, over);
const mandate = (
  kind: RuleScopeKind,
  id: string | null,
  v: number,
  over: Partial<RuleSettingRow> = {},
) => mk('mandate.max_days', kind, id, v, over);

function values(rows: RuleSettingRow[], ctx = CTX, now = NOW) {
  const r = resolveTerms(ctx, rows, now);
  if (!r.ok) throw new Error(`unexpected ${JSON.stringify(r.error)}`);
  return r.value;
}

describe('resolveTerms: defaults and links', () => {
  it('no rows: refund 7, access 7 (raised from 5), mandate 90', () => {
    const t = values([]);
    expect(t.rules_version).toBe('1');
    expect(t.values).toEqual({
      'refund.request_window': 7,
      'access.window': 7,
      'mandate.max_days': 90,
    });
    expect(t.sources).toEqual({
      'refund.request_window': 'default',
      'access.window': 'linked:refund.request_window',
      'mandate.max_days': 'default',
    });
    expect(ResolvedTermsSchema.safeParse(t).success).toBe(true);
  });

  it('access stays at its own value when it is not shorter than refund', () => {
    const t = values([access('platform', null, 10)]);
    expect(t.values['access.window']).toBe(10);
    expect(t.sources['access.window']).toMatch(/^platform:rul_/);
  });

  it('refund 0 leaves the default access window of 5', () => {
    const t = values([refund('platform', null, 0)]);
    expect(t.values['refund.request_window']).toBe(0);
    expect(t.values['access.window']).toBe(5);
    expect(t.sources['access.window']).toBe('default');
  });
});

describe('resolveTerms: precedence and merge', () => {
  it('platform 7 + seller 3: refund 3 (specific scope wins, no merge)', () => {
    const p = refund('platform', null, 7);
    const s = refund('seller', 'pub_1', 3);
    const t = values([p, s]);
    expect(t.values['refund.request_window']).toBe(3);
    expect(t.sources['refund.request_window']).toBe(`seller:pub_1@${s.id}`);
    // Access: default 5, raised to the refund window? 3 < 5, so 5 stays.
    expect(t.values['access.window']).toBe(5);
  });

  it('platform 7 + seller 3 + buyer 10: refund 10 (seller side 3, buyer side 10, merge max)', () => {
    const b = refund('buyer', 'buy_1', 10);
    const t = values([refund('platform', null, 7), refund('seller', 'pub_1', 3), b]);
    expect(t.values['refund.request_window']).toBe(10);
    expect(t.sources['refund.request_window']).toBe(`buyer:buy_1@${b.id}`);
    expect(t.values['access.window']).toBe(10);
  });

  it('seller 14 + buyer 30: refund 30, access 30', () => {
    const t = values([refund('seller', 'pub_1', 14), refund('buyer', 'buy_1', 30)]);
    expect(t.values['refund.request_window']).toBe(30);
    expect(t.values['access.window']).toBe(30);
    expect(t.sources['access.window']).toBe('linked:refund.request_window');
  });

  it('the seller value wins the merge when it is larger', () => {
    const s = refund('seller', 'pub_1', 20);
    const t = values([s, refund('buyer', 'buy_1', 12)]);
    expect(t.values['refund.request_window']).toBe(20);
    expect(t.sources['refund.request_window']).toBe(`seller:pub_1@${s.id}`);
  });

  it('a lone buyer row does not merge with the platform default', () => {
    const t = values([refund('platform', null, 7), refund('buyer', 'buy_1', 2)]);
    expect(t.values['refund.request_window']).toBe(2);
  });

  it('a platform row counts for both sides and never merges with itself', () => {
    const t = values([refund('platform', null, 12)]);
    expect(t.values['refund.request_window']).toBe(12);
  });

  it('seller beats category beats platform on the seller side', () => {
    const rows = [
      refund('platform', null, 7),
      refund('category', 'research', 10),
      refund('seller', 'pub_1', 4),
    ];
    expect(values(rows).values['refund.request_window']).toBe(4);
    expect(values(rows.slice(0, 2)).values['refund.request_window']).toBe(10);
  });

  it('a category row and a buyer row both count as set: merge max', () => {
    const t = values([refund('category', 'research', 14), refund('buyer', 'buy_1', 10)]);
    expect(t.values['refund.request_window']).toBe(14);
  });

  it('rows for another seller, buyer or category do not apply', () => {
    const t = values([
      refund('seller', 'pub_9', 1),
      refund('buyer', 'buy_9', 30),
      refund('category', 'news', 25),
    ]);
    expect(t.values['refund.request_window']).toBe(7);
    expect(t.sources['refund.request_window']).toBe('default');
  });

  it('a null category matches no category row', () => {
    const t = values([refund('category', 'research', 25)], { ...CTX, category: null });
    expect(t.values['refund.request_window']).toBe(7);
  });

  it('platform is a ceiling for mandate.max_days: platform 30 + buyer 60 gives 30', () => {
    const p = mandate('platform', null, 30);
    const t = values([p, mandate('buyer', 'buy_1', 60)]);
    expect(t.values['mandate.max_days']).toBe(30);
    expect(t.sources['mandate.max_days']).toBe(`platform:${p.id}`);
  });

  it('platform 60 + buyer 30 gives 30, source buyer', () => {
    const b = mandate('buyer', 'buy_1', 30);
    const t = values([mandate('platform', null, 60), b]);
    expect(t.values['mandate.max_days']).toBe(30);
    expect(t.sources['mandate.max_days']).toBe(`buyer:buy_1@${b.id}`);
  });

  it('buyer 60 alone (no platform row) gives 60: the registry default is not a row', () => {
    const b = mandate('buyer', 'buy_1', 60);
    const t = values([b]);
    expect(t.values['mandate.max_days']).toBe(60);
    expect(t.sources['mandate.max_days']).toBe(`buyer:buy_1@${b.id}`);
  });

  it('platform and buyer equal: that value, source platform', () => {
    const p = mandate('platform', null, 45);
    const t = values([p, mandate('buyer', 'buy_1', 45)]);
    expect(t.values['mandate.max_days']).toBe(45);
    expect(t.sources['mandate.max_days']).toBe(`platform:${p.id}`);
  });

  it('a platform row does not cap refund (max key): platform 7 + seller 3 still gives 3', () => {
    expect(
      values([refund('platform', null, 7), refund('seller', 'pub_1', 3)]).values[
        'refund.request_window'
      ],
    ).toBe(3);
  });

  it('buyer mandate 30 + platform 90: 30', () => {
    const b = mandate('buyer', 'buy_1', 30);
    const t = values([mandate('platform', null, 90), b]);
    expect(t.values['mandate.max_days']).toBe(30);
    expect(t.sources['mandate.max_days']).toBe(`buyer:buy_1@${b.id}`);
  });

  it('access seller 10 + platform 5: 10', () => {
    const t = values([access('platform', null, 5), access('seller', 'pub_1', 10)]);
    expect(t.values['access.window']).toBe(10);
  });

  it('access: a seller value below the refund window is raised to it', () => {
    const t = values([access('seller', 'pub_1', 2), refund('platform', null, 9)]);
    expect(t.values['access.window']).toBe(9);
    expect(t.sources['access.window']).toBe('linked:refund.request_window');
  });

  it('rows whose scope the key does not allow are ignored', () => {
    // BR-2 refuses these at write time; if one is stored anyway the resolver must not obey it.
    const t = values([
      access('buyer', 'buy_1', 30),
      access('agreement', 'agr_1', 30),
      mandate('seller', 'pub_1', 1),
      mandate('category', 'research', 1),
    ]);
    expect(t.values['access.window']).toBe(7);
    expect(t.values['mandate.max_days']).toBe(90);
  });
});

describe('resolveTerms: tie-breaks inside one scope', () => {
  // Each case runs with the rows in both input orders so an unstable or order-biased sort is caught.
  const both = (rows: RuleSettingRow[]) => [rows, [...rows].reverse()];

  it('latest effective_from wins', () => {
    const rows = [
      refund('seller', 'pub_1', 3, { id: 'rul_b', effective_from: '2026-11-02T00:00:00.000Z' }),
      refund('seller', 'pub_1', 9, { id: 'rul_a', effective_from: '2026-11-03T00:00:00.000Z' }),
      refund('seller', 'pub_1', 5, { id: 'rul_c', effective_from: '2026-11-01T00:00:00.000Z' }),
    ];
    for (const order of both(rows)) {
      expect(values(order).values['refund.request_window']).toBe(9);
    }
  });

  it('equal effective_from: later created_at wins, even with the smaller id', () => {
    const rows = [
      refund('seller', 'pub_1', 3, { id: 'rul_zzz', created_at: '2026-11-02T08:00:00.000Z' }),
      refund('seller', 'pub_1', 9, { id: 'rul_aaa', created_at: '2026-11-02T09:00:00.000Z' }),
    ];
    for (const order of both(rows)) {
      expect(values(order).values['refund.request_window']).toBe(9);
    }
  });

  it('equal effective_from and created_at: the larger id wins', () => {
    const rows = [
      refund('seller', 'pub_1', 3, { id: 'rul_zzz' }),
      refund('seller', 'pub_1', 9, { id: 'rul_aaa' }),
    ];
    for (const order of both(rows)) {
      const t = values(order);
      expect(t.values['refund.request_window']).toBe(3);
      expect(t.sources['refund.request_window']).toBe('seller:pub_1@rul_zzz');
    }
  });

  it('compares instants, not text: a fractional-second spelling does not outrank a later time', () => {
    const rows = [
      refund('seller', 'pub_1', 3, { effective_from: '2026-11-02T00:00:00Z' }),
      refund('seller', 'pub_1', 9, { effective_from: '2026-11-02T00:00:00.500Z' }),
    ];
    for (const order of both(rows)) {
      expect(values(order).values['refund.request_window']).toBe(9);
    }
  });
});

describe('resolveTerms: activity window', () => {
  it('ignores a row before effective_from', () => {
    const t = values([
      refund('seller', 'pub_1', 3, { effective_from: '2026-11-05T12:00:00.001Z' }),
    ]);
    expect(t.values['refund.request_window']).toBe(7);
  });

  it('uses a row exactly at effective_from', () => {
    const t = values([refund('seller', 'pub_1', 3, { effective_from: NOW })]);
    expect(t.values['refund.request_window']).toBe(3);
  });

  it('ignores a row at effective_until, uses it one millisecond earlier', () => {
    const at = refund('seller', 'pub_1', 3, { effective_until: NOW });
    expect(values([at]).values['refund.request_window']).toBe(7);
    const before = refund('seller', 'pub_1', 3, { effective_until: '2026-11-05T12:00:00.001Z' });
    expect(values([before]).values['refund.request_window']).toBe(3);
  });

  it('falls through to an older active row when the newer one has expired', () => {
    const t = values([
      refund('seller', 'pub_1', 4, { effective_from: '2026-10-01T00:00:00.000Z' }),
      refund('seller', 'pub_1', 9, {
        effective_from: '2026-11-01T00:00:00.000Z',
        effective_until: '2026-11-04T00:00:00.000Z',
      }),
    ]);
    expect(t.values['refund.request_window']).toBe(4);
  });

  it('ignores agreement rows until the agreements lane', () => {
    const t = values([refund('agreement', 'agr_1', 30)]);
    expect(t.values['refund.request_window']).toBe(7);
    expect(t.sources['refund.request_window']).toBe('default');
  });
});

describe('resolveTerms: fail closed', () => {
  it.each([
    ['refund above 30', refund('platform', null, 31), 'refund.request_window'],
    ['refund below 0', refund('seller', 'pub_1', -1), 'refund.request_window'],
    ['refund not an integer', refund('buyer', 'buy_1', 2.5), 'refund.request_window'],
    ['refund NaN', refund('platform', null, Number.NaN), 'refund.request_window'],
    ['access 0', access('platform', null, 0), 'access.window'],
    ['access 31', access('seller', 'pub_1', 31), 'access.window'],
    ['mandate 91', mandate('platform', null, 91), 'mandate.max_days'],
    ['mandate 0', mandate('buyer', 'buy_1', 0), 'mandate.max_days'],
  ] as const)('%s gives rules_invalid with the key', (_name, bad, key) => {
    const r = resolveTerms(CTX, [bad], NOW);
    expect(r).toEqual({ ok: false, error: { code: 'rules_invalid', key } });
  });

  it('an out-of-range row that is not the winner does not fail the sale', () => {
    const t = values([
      refund('seller', 'pub_1', 99, { effective_from: '2026-10-01T00:00:00.000Z' }),
      refund('seller', 'pub_1', 4, { effective_from: '2026-11-01T00:00:00.000Z' }),
    ]);
    expect(t.values['refund.request_window']).toBe(4);
  });

  it('an out-of-range winner on one side fails even when the merge would hide it', () => {
    const r = resolveTerms(CTX, [refund('seller', 'pub_1', 99), refund('buyer', 'buy_1', 5)], NOW);
    expect(r).toEqual({
      ok: false,
      error: { code: 'rules_invalid', key: 'refund.request_window' },
    });
  });

  it('a bad now gives rules_invalid rather than a silent default', () => {
    const r = resolveTerms(CTX, [], 'not a time');
    expect(r.ok).toBe(false);
  });
});

describe('resolveTerms: determinism and digest', () => {
  const rows = () => [
    refund('platform', null, 7),
    refund('seller', 'pub_1', 3),
    refund('seller', 'pub_1', 6, { effective_from: '2026-11-02T00:00:00.000Z' }),
    refund('buyer', 'buy_1', 10),
    access('seller', 'pub_1', 12),
    mandate('buyer', 'buy_1', 30),
    mandate('platform', null, 60),
  ];

  it('the same rows in any order give the same values, sources and digest', () => {
    const list = rows();
    const base = values(list);
    expect(values([...list].reverse())).toEqual(base);
    expect(values([...list.slice(3), ...list.slice(0, 3)])).toEqual(base);
    expect(
      values([list[2], list[5], list[0], list[6], list[1], list[4], list[3]] as typeof list),
    ).toEqual(base);
  });

  it('the digest is 64 hex characters and ignores sources', () => {
    const a = values([]);
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
    // Same values reached from a different place: platform row 7 equals the default.
    const b = values([refund('platform', null, 7)]);
    expect(b.values).toEqual(a.values);
    expect(b.digest).toBe(a.digest);
    expect(b.sources).not.toEqual(a.sources);
  });

  it('the digest changes when any value changes', () => {
    const a = values([]).digest;
    expect(values([refund('platform', null, 8)]).digest).not.toBe(a);
    expect(values([mandate('platform', null, 89)]).digest).not.toBe(a);
  });

  it('the digest is sha256 of the canonical JSON of values (sorted keys)', () => {
    const t = values([]);
    const text = '{"access.window":7,"mandate.max_days":90,"refund.request_window":7}';
    expect(t.digest).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });

  it('does not modify its inputs', () => {
    const input = rows();
    const copy = structuredClone(input);
    resolveTerms(CTX, input, NOW);
    expect(input).toEqual(copy);
  });
});
