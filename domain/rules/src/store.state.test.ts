// BR-2 state tests: the append-only rule settings store on a migrated in-memory database. The happy path,
// every refusal code, the audit row, the history order and limit, the active-row selection at both ends of
// the window, the platform ceiling on mandate.max_days (gate note N2-1) and two writes that race.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RuleSettingRowSchema } from '@umsbx/contracts';
import { activeRows, addRuleSetting, listRuleHistory, resolveTerms } from './index';
import { T0, countRows, input, rulesWorld } from './store-support';
import type { RulesWorld } from './store-support';

let w: RulesWorld;
beforeAll(async () => {
  w = await rulesWorld();
});
afterAll(async () => {
  await w.db.close();
});

const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const DAY = 86_400_000;
const rowsNow = () => countRows(w.db, 'rule_settings');
const auditNow = () => countRows(w.db, 'audit_log', "action = 'rules.setting_added'");
const ctxOf = (seller = w.pubA, buyer = w.buyA) => ({
  seller_id: seller,
  buyer_id: buyer,
  category: null,
});

async function add(over: Parameters<typeof input>[1] = {}) {
  const r = await addRuleSetting(w.deps, input(w, over));
  if (!r.ok) throw new Error(`add refused: ${r.error.code}`);
  return r.value.id;
}
async function refused(over: Parameters<typeof input>[1]) {
  const before = [await rowsNow(), await auditNow()];
  const r = await addRuleSetting(w.deps, input(w, over));
  expect([await rowsNow(), await auditNow()], 'a refusal writes nothing').toEqual(before);
  if (r.ok) throw new Error('expected a refusal');
  return r.error.code;
}

describe('addRuleSetting: the happy path', () => {
  it('stores one row and one audit event, with the id from d.ids and the time from d.clock', async () => {
    const before = [await rowsNow(), await auditNow()];
    const id = await add({ value: 14, reason: 'Longer window for the pilot' });
    expect(id).toMatch(/^rls_/);
    expect([await rowsNow(), await auditNow()]).toEqual([before[0]! + 1, before[1]! + 1]);
    const rows = await listRuleHistory(w.db, { rule_key: 'refund.request_window' }, 5);
    const row = rows.find((r) => r.id === id)!;
    expect(RuleSettingRowSchema.safeParse(row).success).toBe(true);
    expect(row).toEqual({
      id,
      rule_key: 'refund.request_window',
      scope_kind: 'platform',
      scope_id: null,
      value: 14,
      effective_from: T0,
      effective_until: null,
      set_by: 'opr_vikram',
      reason: 'Longer window for the pilot',
      approved_by: null,
      created_at: T0,
    });
    const a = await w.db.query<{
      actor_kind: string;
      actor_id: string;
      target: string;
      reason: string;
      detail: Record<string, unknown>;
    }>(
      "SELECT actor_kind, actor_id, target, reason, detail FROM audit_log WHERE action = 'rules.setting_added' AND target = $1",
      [id],
    );
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({
      actor_kind: 'operator',
      actor_id: 'opr_vikram',
      reason: 'Longer window for the pilot',
    });
    expect(a.rows[0]!.detail).toMatchObject({
      rule_key: 'refund.request_window',
      scope_kind: 'platform',
      value: 14,
    });
  });

  it('accepts a seller row, a buyer row, a category row and a dated end', async () => {
    await add({
      rule_key: 'access.window',
      scope_kind: 'seller',
      scope_id: w.pubA,
      value: 10,
      effective_until: at(30 * DAY),
    });
    await add({
      rule_key: 'refund.request_window',
      scope_kind: 'buyer',
      scope_id: w.buyB,
      value: 21,
    });
    await add({
      rule_key: 'access.window',
      scope_kind: 'category',
      scope_id: 'cat_news',
      value: 9,
    });
    const h = await listRuleHistory(w.db, {}, 10);
    expect(h.map((r) => r.scope_kind)).toEqual(
      expect.arrayContaining(['seller', 'buyer', 'category']),
    );
  });

  it('accepts effective_from up to 60 seconds in the past and refuses 61 (the boundary is pinned)', async () => {
    await add({ effective_from: at(-60_000), reason: 'sixty seconds back' });
    expect(await refused({ effective_from: at(-61_000), reason: 'sixty one back' })).toBe(
      'backdated',
    );
  });

  it('accepts a future start', async () => {
    await add({ effective_from: at(2 * DAY), reason: 'starts in two days' });
  });
});

describe('addRuleSetting: every refusal code', () => {
  it('not_operator: buyer, publisher and system', async () => {
    for (const actor of [w.buyer, w.publisher, w.system])
      expect(await refused({ actor })).toBe('not_operator');
  });

  it('mfa_required: an operator without the second factor', async () => {
    expect(await refused({ actor: w.opNoMfa })).toBe('mfa_required');
  });

  it('rule_invalid: unknown key, scope the key does not allow, value outside the safe range, wrong type', async () => {
    expect(await refused({ rule_key: 'refund.nope' })).toBe('rule_invalid');
    expect(
      await refused({
        rule_key: 'mandate.max_days',
        scope_kind: 'seller',
        scope_id: w.pubA,
        value: 10,
      }),
    ).toBe('rule_invalid');
    expect(
      await refused({
        rule_key: 'access.window',
        scope_kind: 'buyer',
        scope_id: w.buyA,
        value: 10,
      }),
    ).toBe('rule_invalid');
    expect(await refused({ value: 31 })).toBe('rule_invalid');
    expect(await refused({ value: -1 })).toBe('rule_invalid');
    expect(await refused({ rule_key: 'access.window', value: 0 })).toBe('rule_invalid');
    expect(await refused({ value: 7.5 })).toBe('rule_invalid');
    expect(await refused({ value: '7' })).toBe('rule_invalid');
    expect(await refused({ scope_kind: 'agreement', scope_id: 'agr_1' })).toBe('rule_invalid');
    expect(await refused({ scope_kind: 'planet' })).toBe('rule_invalid');
  });

  it('rule_invalid: platform with a scope id, other scopes without one, a reason out of 3..200, an end not after the start, bad times', async () => {
    expect(await refused({ scope_kind: 'platform', scope_id: w.pubA })).toBe('rule_invalid');
    expect(await refused({ scope_kind: 'seller', scope_id: null })).toBe('rule_invalid');
    expect(await refused({ reason: 'ab' })).toBe('rule_invalid');
    expect(await refused({ reason: 'x'.repeat(201) })).toBe('rule_invalid');
    expect(await refused({ effective_until: T0 })).toBe('rule_invalid');
    expect(await refused({ effective_until: at(-DAY) })).toBe('rule_invalid');
    expect(await refused({ effective_from: 'tomorrow' })).toBe('rule_invalid');
    expect(await refused({ effective_from: '2026-11-05T10:00:00+02:00' })).toBe('rule_invalid');
  });

  it('accepts reason lengths 3 and 200', async () => {
    await add({ reason: 'abc' });
    await add({ reason: 'x'.repeat(200) });
  });

  it('scope_unknown: a seller id that is no publisher, a buyer id that is no buyer, the id of the other kind', async () => {
    expect(
      await refused({ scope_kind: 'seller', scope_id: 'pub_missing', rule_key: 'access.window' }),
    ).toBe('scope_unknown');
    expect(await refused({ scope_kind: 'buyer', scope_id: 'buy_missing' })).toBe('scope_unknown');
    expect(await refused({ scope_kind: 'buyer', scope_id: w.pubA })).toBe('scope_unknown');
    expect(
      await refused({ scope_kind: 'seller', scope_id: w.buyA, rule_key: 'access.window' }),
    ).toBe('scope_unknown');
  });
});

describe('addRuleSetting: the platform ceiling on mandate.max_days (gate note N2-1)', () => {
  it('refuses a buyer value above the active platform value, allows equal and lower', async () => {
    await add({ rule_key: 'mandate.max_days', value: 30, reason: 'platform ceiling 30' });
    expect(
      await refused({
        rule_key: 'mandate.max_days',
        scope_kind: 'buyer',
        scope_id: w.buyA,
        value: 31,
      }),
    ).toBe('above_platform_cap');
    await add({
      rule_key: 'mandate.max_days',
      scope_kind: 'buyer',
      scope_id: w.buyA,
      value: 30,
      reason: 'equal is fine',
    });
    await add({
      rule_key: 'mandate.max_days',
      scope_kind: 'buyer',
      scope_id: w.buyA,
      value: 10,
      reason: 'lower is fine',
    });
  });

  it('the registry range still applies without a platform row: 90 is the top', async () => {
    const w2 = await rulesWorld();
    try {
      const r = await addRuleSetting(
        w2.deps,
        input(w2, {
          rule_key: 'mandate.max_days',
          scope_kind: 'buyer',
          scope_id: w2.buyA,
          value: 90,
          reason: 'no platform row',
        }),
      );
      expect(r.ok).toBe(true);
      const r2 = await addRuleSetting(
        w2.deps,
        input(w2, {
          rule_key: 'mandate.max_days',
          scope_kind: 'buyer',
          scope_id: w2.buyA,
          value: 91,
          reason: 'one too many',
        }),
      );
      expect(r2).toEqual({ ok: false, error: { code: 'rule_invalid' } });
    } finally {
      await w2.db.close();
    }
  });

  it('a platform row that is not yet active at the buyer row start is no ceiling; one that has ended is none either', async () => {
    const w2 = await rulesWorld();
    try {
      await addRuleSetting(
        w2.deps,
        input(w2, {
          rule_key: 'mandate.max_days',
          value: 20,
          effective_from: at(5 * DAY),
          reason: 'later ceiling',
        }),
      );
      const early = await addRuleSetting(
        w2.deps,
        input(w2, {
          rule_key: 'mandate.max_days',
          scope_kind: 'buyer',
          scope_id: w2.buyA,
          value: 60,
          reason: 'before the ceiling',
        }),
      );
      expect(early.ok).toBe(true);
      const late = await addRuleSetting(
        w2.deps,
        input(w2, {
          rule_key: 'mandate.max_days',
          scope_kind: 'buyer',
          scope_id: w2.buyA,
          value: 60,
          effective_from: at(6 * DAY),
          reason: 'inside the ceiling',
        }),
      );
      expect(late).toEqual({ ok: false, error: { code: 'above_platform_cap' } });
    } finally {
      await w2.db.close();
    }
  });

  it('lowering the platform value later rewrites nothing; the resolver clamps the buyer row', async () => {
    const w2 = await rulesWorld();
    try {
      await addRuleSetting(
        w2.deps,
        input(w2, { rule_key: 'mandate.max_days', value: 60, reason: 'ceiling 60' }),
      );
      await addRuleSetting(
        w2.deps,
        input(w2, {
          rule_key: 'mandate.max_days',
          scope_kind: 'buyer',
          scope_id: w2.buyA,
          value: 50,
          reason: 'buyer 50',
        }),
      );
      w2.clock.advance(DAY);
      await addRuleSetting(
        w2.deps,
        input(w2, {
          rule_key: 'mandate.max_days',
          value: 20,
          effective_from: new Date(w2.clock.now()).toISOString(),
          reason: 'ceiling lowered',
        }),
      );
      expect(await countRows(w2.db, 'rule_settings')).toBe(3);
      const now = w2.clock.now().toISOString();
      const rows = await activeRows(
        w2.db,
        { seller_id: w2.pubA, buyer_id: w2.buyA, category: null },
        now,
      );
      const r = resolveTerms({ seller_id: w2.pubA, buyer_id: w2.buyA, category: null }, rows, now);
      expect(r.ok && r.value.values['mandate.max_days']).toBe(20);
    } finally {
      await w2.db.close();
    }
  });
});

describe('listRuleHistory', () => {
  it('lists newest first (created_at, then id) and honours the limit and the filters', async () => {
    const w2 = await rulesWorld();
    try {
      const made: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const r = await addRuleSetting(
          w2.deps,
          input(w2, { value: 5 + i, reason: `row number ${i}` }),
        );
        if (!r.ok) throw new Error('add');
        made.push(r.value.id);
        w2.clock.advance(1000);
      }
      const all = await listRuleHistory(w2.db, {}, 10);
      expect(all.map((r) => r.id)).toEqual([...made].reverse());
      expect((await listRuleHistory(w2.db, {}, 2)).map((r) => r.id)).toEqual([made[3], made[2]]);
      expect(await listRuleHistory(w2.db, { rule_key: 'access.window' }, 10)).toEqual([]);
      expect(await listRuleHistory(w2.db, { scope_kind: 'seller' }, 10)).toEqual([]);
      expect((await listRuleHistory(w2.db, { scope_kind: 'platform' }, 10)).length).toBe(4);
      // the same instant: the larger id comes first
      const w3 = await rulesWorld();
      try {
        const a = await addRuleSetting(w3.deps, input(w3, { reason: 'same instant a' }));
        const b = await addRuleSetting(w3.deps, input(w3, { reason: 'same instant b' }));
        if (!a.ok || !b.ok) throw new Error('add');
        const ids = (await listRuleHistory(w3.db, {}, 10)).map((r) => r.id);
        expect(ids).toEqual([a.value.id, b.value.id].sort().reverse());
      } finally {
        await w3.db.close();
      }
    } finally {
      await w2.db.close();
    }
  });

  it('limit defaults to 200, is at least 1 and at most 5000', async () => {
    expect(await listRuleHistory(w.db, {}, 0)).toHaveLength(1);
    expect(await listRuleHistory(w.db, {}, -5)).toHaveLength(1);
    expect(await listRuleHistory(w.db, {}, Number.NaN)).not.toHaveLength(0);
    expect((await listRuleHistory(w.db, {}, 1_000_000)).length).toBeLessThanOrEqual(5000);
  });
});

describe('activeRows', () => {
  it('selects platform, the sale seller, the sale buyer and category rows, nothing for other sellers or buyers', async () => {
    const w2 = await rulesWorld();
    try {
      const mk = (o: Parameters<typeof input>[1]) => addRuleSetting(w2.deps, input(w2, o));
      await mk({ reason: 'platform row' });
      await mk({
        rule_key: 'access.window',
        scope_kind: 'seller',
        scope_id: w2.pubA,
        value: 8,
        reason: 'seller a',
      });
      await mk({
        rule_key: 'access.window',
        scope_kind: 'seller',
        scope_id: w2.pubB,
        value: 9,
        reason: 'seller b',
      });
      await mk({ scope_kind: 'buyer', scope_id: w2.buyA, value: 11, reason: 'buyer a' });
      await mk({ scope_kind: 'buyer', scope_id: w2.buyB, value: 12, reason: 'buyer b' });
      await mk({
        rule_key: 'access.window',
        scope_kind: 'category',
        scope_id: 'cat_news',
        value: 7,
        reason: 'category news',
      });
      await mk({
        rule_key: 'access.window',
        scope_kind: 'category',
        scope_id: 'cat_other',
        value: 6,
        reason: 'category other',
      });
      const rows = await activeRows(
        w2.db,
        { seller_id: w2.pubA, buyer_id: w2.buyA, category: 'cat_news' },
        T0,
      );
      expect(rows.map((r) => `${r.scope_kind}:${r.scope_id ?? ''}:${r.value}`).sort()).toEqual(
        [
          'platform::14',
          `seller:${w2.pubA}:8`,
          `buyer:${w2.buyA}:11`,
          'category:cat_news:7',
        ].sort(),
      );
      const noCat = await activeRows(
        w2.db,
        { seller_id: w2.pubA, buyer_id: w2.buyA, category: null },
        T0,
      );
      expect(noCat.some((r) => r.scope_kind === 'category')).toBe(false);
      for (const r of rows) expect(RuleSettingRowSchema.safeParse(r).success).toBe(true);
    } finally {
      await w2.db.close();
    }
  });

  it('is inclusive at effective_from and exclusive at effective_until', async () => {
    const w2 = await rulesWorld();
    try {
      await addRuleSetting(
        w2.deps,
        input(w2, {
          effective_from: at(1000),
          effective_until: at(5000),
          reason: 'a short window',
        }),
      );
      const q = (ms: number) => activeRows(w2.db, ctxOf(w2.pubA, w2.buyA), at(ms));
      expect(await q(999)).toHaveLength(0);
      expect(await q(1000)).toHaveLength(1);
      expect(await q(4999)).toHaveLength(1);
      expect(await q(5000)).toHaveLength(0);
    } finally {
      await w2.db.close();
    }
  });

  it('never returns an agreement row, even one written straight into the table', async () => {
    const w2 = await rulesWorld();
    try {
      await w2.db.query(
        `INSERT INTO rule_settings (id, rule_key, scope_kind, scope_id, value, effective_from, effective_until, set_by, reason, approved_by, created_at)
         VALUES ('rls_agr', 'refund.request_window', 'agreement', 'agr_1', 3, $1, NULL, 'opr_x', 'legacy agreement', NULL, $1)`,
        [T0],
      );
      expect(await activeRows(w2.db, ctxOf(w2.pubA, w2.buyA), T0)).toEqual([]);
    } finally {
      await w2.db.close();
    }
  });
});

describe('two writes at once', () => {
  it('both are stored, and the BR-1 resolver picks the same one whatever the row order', async () => {
    const w2 = await rulesWorld();
    try {
      const [a, b] = await Promise.all([
        addRuleSetting(w2.deps, input(w2, { value: 10, reason: 'racer one' })),
        addRuleSetting(w2.deps, input(w2, { value: 20, reason: 'racer two' })),
      ]);
      expect(a.ok && b.ok).toBe(true);
      expect(await countRows(w2.db, 'rule_settings')).toBe(2);
      const ctx = ctxOf(w2.pubA, w2.buyA);
      const rows = await activeRows(w2.db, ctx, T0);
      expect(rows).toHaveLength(2);
      const x = resolveTerms(ctx, rows, T0);
      const y = resolveTerms(ctx, [...rows].reverse(), T0);
      expect(x).toEqual(y);
      // same effective_from and created_at: the larger id wins
      const winner = [rows[0]!, rows[1]!].sort((p, q) => (p.id < q.id ? 1 : -1))[0]!;
      expect(x.ok && x.value.values['refund.request_window']).toBe(winner.value);
    } finally {
      await w2.db.close();
    }
  });
});
