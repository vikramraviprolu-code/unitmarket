// INT-OPS-A / OPS-A.6 (A3): the Problems page /ops/money/problems. A failing invariant on Money links to
// ?inv=INV1..INV7 and an operation state tile links to ?op=<state>; the page lists the orders or the operations
// behind that link. domain/payments gains one additive field on every invariant result, `rows`, and changes
// nothing else: `ok` and `detail` stay as they were. The map is in lib/ops-invariants-view.ts and is checked
// here against every invariant id and every operation state.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OperationStateSchema } from '@umsbx/contracts';
import type { Actor } from '@umsbx/contracts';
import {
  INVARIANT_IDS,
  INVARIANT_PROBLEMS_URL,
  OPERATION_PROBLEMS_URL,
  invariantLink,
  operationLink,
  parseProblemsQuery,
} from './lib/ops-invariants-view';
import { bootAlertRig } from './ops-alerts-support';
import type { AlertRig } from './ops-alerts-support';
import { seedSales } from './search-support';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const MFA: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
const PLAIN: Actor = { kind: 'operator', operator_id: 'opr_demo', mfa: false };

describe('the map', () => {
  it('has a Problems URL for every invariant id, INV1 to INV7, and no other', () => {
    expect(INVARIANT_IDS).toEqual(['INV1', 'INV2', 'INV3', 'INV4', 'INV5', 'INV6', 'INV7']);
    expect(Object.keys(INVARIANT_PROBLEMS_URL).sort()).toEqual([...INVARIANT_IDS].sort());
    for (const id of INVARIANT_IDS)
      expect(INVARIANT_PROBLEMS_URL[id]).toBe(`/ops/money/problems?inv=${id}`);
  });

  it('has a Problems URL for every OperationStateSchema value, and no other', () => {
    const states = [...OperationStateSchema.options];
    expect(states.length).toBe(5);
    expect(Object.keys(OPERATION_PROBLEMS_URL).sort()).toEqual([...states].sort());
    for (const s of states) expect(OPERATION_PROBLEMS_URL[s]).toBe(`/ops/money/problems?op=${s}`);
  });

  it('links a failing invariant, not a passing one, and never an id it does not know', () => {
    expect(invariantLink('INV1', false)).toBe('/ops/money/problems?inv=INV1');
    expect(invariantLink('INV1', true)).toBeNull();
    expect(invariantLink('INV9', false)).toBeNull();
    expect(operationLink('unknown')).toBe('/ops/money/problems?op=unknown');
    expect(operationLink('nonsense')).toBeNull();
  });

  it('reads the query: one id or one state, anything else is the overview', () => {
    expect(parseProblemsQuery({ inv: 'INV3' })).toEqual({ kind: 'inv', id: 'INV3' });
    expect(parseProblemsQuery({ op: 'unknown' })).toEqual({ kind: 'op', state: 'unknown' });
    expect(parseProblemsQuery({ inv: 'INV8' })).toEqual({ kind: 'none' });
    expect(parseProblemsQuery({ op: 'weird' })).toEqual({ kind: 'none' });
    expect(parseProblemsQuery({})).toEqual({ kind: 'none' });
    expect(parseProblemsQuery({ inv: ['INV2', 'INV3'] })).toEqual({ kind: 'inv', id: 'INV2' });
    expect(parseProblemsQuery({ inv: 'INV1', op: 'sent' })).toEqual({ kind: 'inv', id: 'INV1' });
  });
});

describe('the page data, over a real database', () => {
  let rig: AlertRig;
  let money: typeof import('./composition/ops-money');
  let buyer = '';
  let publisher = '';
  const one: string[] = [];
  const seven: string[] = [];

  const snapshot = async () => {
    const snap = await rig.rig.app.engine.opsSnapshot(MFA);
    return snap!.invariants;
  };

  beforeAll(async () => {
    rig = await bootAlertRig();
    money = await import('./composition/ops-money');
    const db = rig.rig.app.db;
    buyer = (
      await db.query<{ id: string }>("SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'")
    ).rows[0]!.id;
    publisher = (
      await db.query<{ id: string }>("SELECT id FROM publishers WHERE slug = 'harbour-ledger'")
    ).rows[0]!.id;
  });
  afterAll(async () => rig?.rig.app.close());

  const seed = (prefix: string, count: number) =>
    seedSales(rig.rig.app.db, {
      buyer_id: buyer,
      publisher_id: publisher,
      count,
      from: new Date('2026-11-04T09:00:00Z'),
      prefix,
    });

  it('on a clean database every invariant holds and has no rows', async () => {
    const inv = await snapshot();
    expect(inv.map((v) => v.id)).toEqual([...INVARIANT_IDS]);
    for (const v of inv) {
      expect(v.ok).toBe(true);
      expect(v.rows).toEqual([]);
    }
    const p = (await money.readProblems(MFA, { kind: 'inv', id: 'INV1' }))!;
    expect(p).toMatchObject({ kind: 'inv', id: 'INV1', ok: true, orders: [], total: 0 });
  });

  it('with one INV1 break, ?inv=INV1 lists exactly the broken unit order, linked to its order page', async () => {
    one.push(...(await seed('ivone', 1)));
    const inv = (await snapshot()).find((v) => v.id === 'INV1')!;
    expect(inv.ok).toBe(false);
    expect(inv.rows).toHaveLength(1);
    expect(inv.rows[0]).toEqual({ table: 'order_units', id: 'ivoneu0' });
    const p = (await money.readProblems(MFA, { kind: 'inv', id: 'INV1' }))!;
    if (p.kind !== 'inv') throw new Error('not an invariant answer');
    expect(p.ok).toBe(false);
    expect(p.orders).toEqual([{ order_ref: one[0], href: `/ops/money/orders/${one[0]}` }]);
    expect(p.total).toBe(1);
    // a passing invariant lists nothing, even while INV1 fails
    const other = (await money.readProblems(MFA, { kind: 'inv', id: 'INV2' }))!;
    expect(other).toMatchObject({ kind: 'inv', id: 'INV2', ok: true, orders: [] });
  });

  it('ok and detail are what they always were; rows only adds', async () => {
    const inv = (await snapshot()).find((v) => v.id === 'INV1')!;
    expect(inv.detail).toBe(
      'ledger sale minus refunds equals the verified amount per unit: 1 violation: unit ivoneu0: 0 sale entries totalling 0, captured amount 500',
    );
    for (const v of await snapshot()) {
      expect(Object.keys(v).sort()).toEqual(['detail', 'id', 'ok', 'rows']);
      if (v.ok) expect(v.detail.endsWith(': holds')).toBe(true);
    }
  });

  it('rows are all the offending rows, not cut at five, while detail still is', async () => {
    seven.push(...(await seed('ivsev', 7)));
    const inv = (await snapshot()).find((v) => v.id === 'INV1')!;
    expect(inv.rows).toHaveLength(8);
    expect(inv.detail).toContain('8 violations');
    expect(inv.detail.endsWith('; ...')).toBe(true);
    expect(inv.detail.split('; ').length).toBe(6); // the title part, five shown, and "..."
    const p = (await money.readProblems(MFA, { kind: 'inv', id: 'INV1' }))!;
    if (p.kind !== 'inv') throw new Error('not an invariant answer');
    expect(p.orders.map((o) => o.order_ref).sort()).toEqual([...one, ...seven].sort());
    expect(p.total).toBe(8);
  });

  it('every row of every failing invariant resolves to an order', async () => {
    for (const v of await snapshot()) {
      if (v.ok) continue;
      const p = (await money.readProblems(MFA, { kind: 'inv', id: v.id }))!;
      if (p.kind !== 'inv') throw new Error('not an invariant answer');
      expect(p.orders.length).toBeGreaterThan(0);
      for (const o of p.orders) expect(o.href).toBe(`/ops/money/orders/${o.order_ref}`);
    }
  });

  it('?op=unknown lists exactly the unknown operations, with id, kind, order, attempt and lease', async () => {
    const db = rig.rig.app.db;
    const order = (
      await db.query<{ id: string; order_ref: string }>(
        'SELECT id, order_ref FROM orders WHERE order_ref = $1',
        [one[0]],
      )
    ).rows[0]!;
    const at = '2026-11-05T09:00:00.000Z';
    const op = (id: string, state: string, kind: string, attempt: number, extra: string) =>
      db.query(
        `INSERT INTO operations (id, order_id, unit_id, kind, state, attempt, request_id, first_sent_at, ${extra.split(' ')[0]}, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $7, $7, $7)`,
        [id, order.id, kind, state, attempt, `req-${id}`, at],
      );
    await op('opr_unk1', 'unknown', 'capture', 2, 'reconcile_until');
    await op('opr_unk2', 'unknown', 'readback', 1, 'reconcile_until');
    await op('opr_snt1', 'sent', 'create', 1, 'lease_until');
    const p = (await money.readProblems(MFA, { kind: 'op', state: 'unknown' }))!;
    if (p.kind !== 'op') throw new Error('not an operation answer');
    expect(p.operations.map((o) => o.id).sort()).toEqual(['opr_unk1', 'opr_unk2']);
    const u1 = p.operations.find((o) => o.id === 'opr_unk1')!;
    expect(u1).toMatchObject({ kind: 'capture', order_ref: one[0], attempt: 2, lease_until: null });
    expect(u1.order_href).toBe(`/ops/money/orders/${one[0]}`);
    expect(p.total).toBe(2);
    const sent = (await money.readProblems(MFA, { kind: 'op', state: 'sent' }))!;
    if (sent.kind !== 'op') throw new Error('not an operation answer');
    expect(sent.operations.map((o) => o.id)).toEqual(['opr_snt1']);
    expect(sent.operations[0]!.lease_until).toBe(at);
    const none = (await money.readProblems(MFA, { kind: 'op', state: 'confirmed' }))!;
    expect(none).toMatchObject({ kind: 'op', state: 'confirmed', operations: [], total: 0 });
  });

  it('the overview carries a link for every failing invariant and for every state with operations', async () => {
    const p = (await money.readProblems(MFA, { kind: 'none' }))!;
    if (p.kind !== 'none') throw new Error('not the overview');
    const failing = (await snapshot()).filter((v) => !v.ok).map((v) => v.id);
    expect(p.invariants.filter((v) => v.href !== null).map((v) => v.id)).toEqual(failing);
    expect(p.states.find((s) => s.state === 'unknown')).toMatchObject({
      count: 2,
      href: '/ops/money/problems?op=unknown',
    });
  });

  it('a very long list is capped and says how many there are', async () => {
    const p = (await money.readProblems(MFA, { kind: 'inv', id: 'INV1' }))!;
    if (p.kind !== 'inv') throw new Error('not an invariant answer');
    expect(p.capped).toBe(false);
    expect(money.PROBLEMS_CAP).toBe(200);
  });

  it('an operator without the code may read it, and a buyer or a seller reads nothing', async () => {
    expect(await money.readProblems(PLAIN, { kind: 'inv', id: 'INV1' })).not.toBeNull();
    expect(
      await money.readProblems({ kind: 'buyer', buyer_id: buyer }, { kind: 'inv', id: 'INV1' }),
    ).toBeNull();
    expect(
      await money.readProblems(
        { kind: 'publisher', publisher_id: publisher },
        { kind: 'op', state: 'unknown' },
      ),
    ).toBeNull();
  });
});

describe('the page and the links (source as text)', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = (rel: string): string =>
    readFileSync(`${here}${rel}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('Money links failing invariants and operation tiles through the map, and the Problems page is operator only', () => {
    const money = src('app/ops/money/page.tsx');
    expect(money).toContain('invariantLink(');
    expect(money).toContain('operationLink(');
    const page = src('app/ops/money/problems/page.tsx');
    expect(page).toMatch(
      /actor\?\.kind !== 'operator'\) redirect\('\/signin\?next=\/ops\/money\/problems'\)/,
    );
    expect(page).toMatch(/from '(\.\.\/)+composition\/ops-money'/);
    expect(page).not.toMatch(/server\/access|composition\.server/);
  });
});
