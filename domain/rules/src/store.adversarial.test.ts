// BR-2 adversarial tests: hostile input to the write path. Everything an attacker controls is data or a
// refusal, never SQL; the second factor is checked in the domain even when the route is bypassed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeRows, addRuleSetting, listRuleHistory } from './index';
import { T0, countRows, input, rulesWorld } from './store-support';
import type { RulesWorld } from './store-support';

let w: RulesWorld;
beforeAll(async () => {
  w = await rulesWorld();
});
afterAll(async () => {
  await w.db.close();
});

const INJECTIONS = [
  "x'; DROP TABLE rule_settings; --",
  "' OR '1'='1",
  '"; DELETE FROM audit_log; --',
  '${process.env.SECRET}',
  '../../etc/passwd',
  'cat_‮evil',
  'a'.repeat(200),
];

describe('scope_id injection strings', () => {
  it('on a seller or buyer scope they are refused as scope_unknown and nothing runs', async () => {
    for (const s of INJECTIONS) {
      for (const kind of ['seller', 'buyer'] as const) {
        const r = await addRuleSetting(
          w.deps,
          input(w, {
            scope_kind: kind,
            scope_id: s,
            rule_key: kind === 'seller' ? 'access.window' : 'refund.request_window',
          }),
        );
        expect(r.ok, `${kind} ${s}`).toBe(false);
        if (!r.ok) expect(['scope_unknown', 'rule_invalid']).toContain(r.error.code);
      }
    }
    expect(await countRows(w.db, 'rule_settings')).toBe(0);
    expect(await countRows(w.db, 'audit_log', "action = 'rules.setting_added'")).toBe(0);
    expect(await countRows(w.db, 'publishers')).toBe(2);
  });

  it('on a category scope they are stored as data, byte for byte, and the table survives', async () => {
    const stored: string[] = [];
    for (const s of INJECTIONS) {
      const r = await addRuleSetting(
        w.deps,
        input(w, {
          rule_key: 'access.window',
          scope_kind: 'category',
          scope_id: s,
          value: 6,
          reason: 'category label',
        }),
      );
      if (r.ok) stored.push(s);
    }
    expect(stored.length).toBeGreaterThan(0);
    const back = (await listRuleHistory(w.db, { scope_kind: 'category' }, 100)).map(
      (r) => r.scope_id,
    );
    for (const s of stored) expect(back).toContain(s);
    expect(await countRows(w.db, 'publishers')).toBe(2);
    expect(await countRows(w.db, 'rule_settings')).toBe(stored.length);
    // asking for a category that looks like SQL returns rows by equality only
    const rows = await activeRows(
      w.db,
      { seller_id: w.pubA, buyer_id: w.buyA, category: "' OR '1'='1" },
      T0,
    );
    expect(rows.every((r) => r.scope_id === "' OR '1'='1")).toBe(true);
  });
});

describe('wrong JSON types and shapes', () => {
  it.each([
    ['a string', '7'],
    ['null', null],
    ['a boolean', true],
    ['an object', { v: 7 }],
    ['an array', [7]],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a float', 7.0000001],
    ['a huge number', 1e21],
    ['negative zero is still 0 and out of range for access.window', -0],
  ])('value %s is refused', async (_n, v) => {
    const key = _n.startsWith('negative zero') ? 'access.window' : 'refund.request_window';
    const before = await countRows(w.db, 'rule_settings');
    const r = await addRuleSetting(w.deps, input(w, { rule_key: key, value: v }));
    expect(r).toEqual({ ok: false, error: { code: 'rule_invalid' } });
    expect(await countRows(w.db, 'rule_settings')).toBe(before);
  });

  it('an extra field, a missing field and a non-object are refused', async () => {
    const base = input(w);
    const extra = { ...base, approved_by: 'opr_other' } as unknown as Parameters<
      typeof addRuleSetting
    >[1];
    expect(await addRuleSetting(w.deps, extra)).toEqual({
      ok: false,
      error: { code: 'rule_invalid' },
    });
    const { reason: _r, ...missing } = base;
    expect(
      await addRuleSetting(w.deps, missing as unknown as Parameters<typeof addRuleSetting>[1]),
    ).toEqual({ ok: false, error: { code: 'rule_invalid' } });
    expect(
      await addRuleSetting(w.deps, null as unknown as Parameters<typeof addRuleSetting>[1]),
    ).toEqual({ ok: false, error: { code: 'rule_invalid' } });
  });

  it('a prototype-polluting key is refused', async () => {
    const bad = JSON.parse(
      `{"__proto__":{"admin":true},"actor":${JSON.stringify(w.opMfa)},"rule_key":"refund.request_window","scope_kind":"platform","scope_id":null,"value":7,"effective_from":"${T0}","effective_until":null,"reason":"proto test"}`,
    );
    expect(await addRuleSetting(w.deps, bad)).toEqual({
      ok: false,
      error: { code: 'rule_invalid' },
    });
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
  });
});

describe('scope of the id', () => {
  it('a publisher id with scope_kind buyer, and a buyer id with scope_kind seller, are scope_unknown', async () => {
    expect(
      await addRuleSetting(w.deps, input(w, { scope_kind: 'buyer', scope_id: w.pubA })),
    ).toEqual({ ok: false, error: { code: 'scope_unknown' } });
    expect(
      await addRuleSetting(
        w.deps,
        input(w, { rule_key: 'access.window', scope_kind: 'seller', scope_id: w.buyA }),
      ),
    ).toEqual({ ok: false, error: { code: 'scope_unknown' } });
  });
});

describe('who may write, checked in the domain', () => {
  it('an operator session without the second factor is refused even when the route is bypassed', async () => {
    const before = await countRows(w.db, 'rule_settings');
    expect(await addRuleSetting(w.deps, input(w, { actor: w.opNoMfa }))).toEqual({
      ok: false,
      error: { code: 'mfa_required' },
    });
    expect(await countRows(w.db, 'rule_settings')).toBe(before);
  });

  it('a forged actor (mfa as a string, an empty operator id) is refused', async () => {
    const forged = { kind: 'operator', operator_id: '', mfa: 'true' } as never;
    const r = await addRuleSetting(w.deps, input(w, { actor: forged }));
    expect(r.ok).toBe(false);
    const forged2 = { kind: 'operator', operator_id: 'opr_x', mfa: 'true' } as never;
    expect((await addRuleSetting(w.deps, input(w, { actor: forged2 }))).ok).toBe(false);
  });

  it('the rows are append-only: no update, no delete, no truncate', async () => {
    await addRuleSetting(w.deps, input(w, { reason: 'append only check' }));
    await expect(w.db.query('UPDATE rule_settings SET value = 1')).rejects.toThrow(/append-only/);
    await expect(w.db.query('DELETE FROM rule_settings')).rejects.toThrow(/append-only/);
    await expect(w.db.exec('TRUNCATE rule_settings')).rejects.toThrow(/TRUNCATE|append-only/);
  });
});

describe('history size', () => {
  it('201 rows come back as 200 by default and as 201 with limit 500', async () => {
    const w2 = await rulesWorld();
    try {
      for (let i = 0; i < 201; i += 1) {
        const r = await addRuleSetting(
          w2.deps,
          input(w2, { value: (i % 30) + 1, reason: `bulk ${i}` }),
        );
        if (!r.ok) throw new Error(`bulk ${i}: ${r.error.code}`);
        w2.clock.advance(1);
      }
      expect(await listRuleHistory(w2.db, {})).toHaveLength(200);
      expect(await listRuleHistory(w2.db, {}, 500)).toHaveLength(201);
    } finally {
      await w2.db.close();
    }
  });
});
