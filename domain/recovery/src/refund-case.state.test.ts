// CO-4 goal 5: a recovery case in refund_pending follows its refund. It moves to `refunded` when
// every refund request the offer made reads completed, and back to `diagnosing`, with an alert and
// an action row, when one of them failed, was cancelled or was rejected by PayPal. While a request
// is still open or unresolved the case waits. The rule runs in applyAutomaticRules (the job loop).
// The refund rows are those of payments; recovery only reads them (payments is never imported).
// Real PGlite, synthetic rows only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@umsbx/contracts';
import { applyAutomaticRules, listCasesForBuyer, openCase, resolve } from './index';
import { HOUR, makeWorld } from './world';
import type { World } from './world';

const operator = { kind: 'operator', operator_id: 'opr_1', mfa: true } as const;

let w: World;
beforeAll(async () => {
  w = await makeWorld('rfc');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
  w.clock.set('2026-10-21T10:00:00.000Z');
});

let seq = 0;
/** The refund path as the composition wires it: a request row per unit, in `requested`. */
function requester(w: World, made: string[], idsOf?: (own: string) => string | Promise<string>) {
  return async (i: { unit_id: string; amount: unknown; reason: string; actor: unknown }) => {
    seq += 1;
    const id = `rfr_c${seq}`;
    const cap = (
      await w.db.query<{ capture_id: string }>('SELECT capture_id FROM order_units WHERE id = $1', [
        i.unit_id,
      ])
    ).rows[0]!.capture_id;
    await w.insert('refund_requests', {
      id,
      unit_id: i.unit_id,
      capture_id: cap,
      amount_minor: 500,
      currency: 'USD',
      reason: i.reason,
      requested_by: 'operator:opr_1',
      state: 'requested',
      refund_id: null,
    });
    made.push(id);
    return {
      ok: true as const,
      value: { refund_request_id: idsOf === undefined ? id : await idsOf(id) },
    };
  };
}
async function pendingCase(
  items: number[],
  made: string[] = [],
  idsOf?: (own: string) => string | Promise<string>,
) {
  const first = await w.item(items[0]!);
  const extra = [];
  for (const n of items.slice(1)) extra.push(await w.item(n));
  const c = await openCase(w.deps, {
    kind: 'refund_requested',
    entitlement_id: first.entitlement_id,
    opened_by: 'operator',
    actor: operator,
  });
  if (!c.ok) throw new Error('open failed');
  const r = await resolve(
    { ...w.deps, requestRefund: requester(w, made, idsOf) as never },
    { case_id: c.value.case_id, action: 'offer_refund', by: operator, reason: 'buyer asked' },
  );
  if (!r.ok) throw new Error(`offer failed ${r.error.code}`);
  expect(r.value.state).toBe('refund_pending');
  return { case_id: c.value.case_id, first, extra, made };
}
const setRequest = (id: string, state: string, refund_id: string | null = null) =>
  w.db.query('UPDATE refund_requests SET state = $2, refund_id = $3 WHERE id = $1', [
    id,
    state,
    refund_id,
  ]);
const stateOf = async (case_id: string) =>
  (await w.db.query<{ state: string }>('SELECT state FROM recovery_cases WHERE id = $1', [case_id]))
    .rows[0]!.state;
const messageOf = async (case_id: string) =>
  (
    await w.db.query<{ buyer_message: string }>(
      'SELECT buyer_message FROM recovery_cases WHERE id = $1',
      [case_id],
    )
  ).rows[0]!.buyer_message;
const actionsOf = async (case_id: string) =>
  (
    await w.db.query<{ action: string; actor: string }>(
      'SELECT action, actor FROM recovery_actions WHERE case_id = $1 ORDER BY created_at, ctid',
      [case_id],
    )
  ).rows;
const alertsOf = async () =>
  (
    await w.db.query<{
      kind: string;
      order_id: string;
      unit_id: string | null;
      detail: { reason: string };
    }>('SELECT kind, order_id, unit_id, detail FROM alerts ORDER BY kind, id')
  ).rows;
const sweep = () => applyAutomaticRules(w.deps, { max_items: 20 });

describe('refund_pending case follows its refund', () => {
  it('refund_pending case moves to refunded on COMPLETED and back to diagnosing on FAILED', async () => {
    // COMPLETED
    const done = await pendingCase([1]);
    await setRequest(done.made[0]!, 'completed', 'RF1');
    await sweep();
    expect(await stateOf(done.case_id)).toBe('refunded');
    expect((await actionsOf(done.case_id)).map((x) => x.action)).toEqual([
      'offer_refund',
      'refund_completed',
    ]);
    expect(await alertsOf()).toEqual([]);
    // FAILED
    const bad = await pendingCase([2]);
    await setRequest(bad.made[0]!, 'failed', 'RF2');
    await sweep();
    expect(await stateOf(bad.case_id)).toBe('diagnosing');
    expect((await actionsOf(bad.case_id)).map((x) => x.action)).toEqual([
      'offer_refund',
      'refund_failed',
    ]);
    const alerts = await alertsOf();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'refund_failed', order_id: 'ord_2', unit_id: 'unt_2' });
  });

  it('the buyer reads a plain message in each state', async () => {
    const done = await pendingCase([1]);
    await setRequest(done.made[0]!, 'completed', 'RF1');
    await sweep();
    expect(await messageOf(done.case_id)).toBe(
      'Your refund went through. It shows on your receipt.',
    );
    const bad = await pendingCase([2]);
    await setRequest(bad.made[0]!, 'cancelled', 'RF2');
    await sweep();
    expect(await messageOf(bad.case_id)).toBe(
      'The refund did not go through. We are looking into it and will write to you.',
    );
    const views = await listCasesForBuyer(w.db, { buyer_id: 'buy_1' });
    expect(views.map((v) => v.state).sort()).toEqual(['diagnosing', 'refunded']);
  });

  it.each(['failed', 'cancelled', 'rejected'])(
    'a %s request sends the case back to diagnosing with an alert',
    async (state) => {
      const c = await pendingCase([1]);
      await setRequest(c.made[0]!, state, state === 'rejected' ? null : 'RF1');
      await sweep();
      expect(await stateOf(c.case_id)).toBe('diagnosing');
      expect((await alertsOf()).map((a) => a.kind)).toEqual(['refund_failed']);
    },
  );

  it.each(['requested', 'sent', 'unknown', 'pending', 'unresolved'])(
    'a %s request leaves the case in refund_pending',
    async (state) => {
      const c = await pendingCase([1]);
      await setRequest(c.made[0]!, state, state === 'pending' ? 'RF1' : null);
      await sweep();
      expect(await stateOf(c.case_id)).toBe('refund_pending');
      expect((await actionsOf(c.case_id)).map((x) => x.action)).toEqual(['opened', 'offer_refund']);
      expect(await alertsOf()).toEqual([]);
    },
  );

  const extraRequest = async (unit: number, state: string, refund_id: string | null) => {
    seq += 1;
    const id = `rfr_c${seq}`;
    await w.insert('refund_requests', {
      id,
      unit_id: `unt_${unit}`,
      capture_id: `CAP${unit}`,
      amount_minor: 100,
      currency: 'USD',
      reason: 'x',
      requested_by: 'operator:opr_1',
      state,
      refund_id,
    });
    return id;
  };

  it('several requests: all completed is refunded; one failed is diagnosing; one still open waits', async () => {
    // The offer asks one refund per verified unit of the case; the requester returns the ids the
    // offer records, so a case that follows several requests is built from a list of ids.
    let second = '';
    const c = await pendingCase([1], [], async (own) => {
      second = await extraRequest(1, 'requested', null);
      return `${own},${second}`;
    });
    await setRequest(c.made[0]!, 'completed', 'RF1');
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refund_pending'); // the second is still open
    await setRequest(second, 'pending', 'RF2');
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refund_pending');
    await setRequest(second, 'completed', 'RF2');
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refunded');

    const d = await pendingCase(
      [2],
      [],
      async (own) => `${own},${await extraRequest(2, 'failed', 'RF9')}`,
    );
    await setRequest(d.made[0]!, 'pending', 'RF8');
    await sweep();
    expect(await stateOf(d.case_id)).toBe('refund_pending'); // one failed, one still open: wait
    await setRequest(d.made[0]!, 'completed', 'RF8');
    await sweep();
    expect(await stateOf(d.case_id)).toBe('diagnosing'); // all settled, one failed
  });

  it('runs once: a second sweep adds no action, no alert, no new message', async () => {
    const c = await pendingCase([1]);
    await setRequest(c.made[0]!, 'failed', 'RF1');
    await sweep();
    const actions = await actionsOf(c.case_id);
    const alerts = await alertsOf();
    await sweep();
    await sweep();
    expect(await actionsOf(c.case_id)).toEqual(actions);
    expect(await alertsOf()).toEqual(alerts);
    expect(await stateOf(c.case_id)).toBe('diagnosing');
  });

  it('a case sent back to diagnosing can offer a new refund and follow that one', async () => {
    const c = await pendingCase([1]);
    await setRequest(c.made[0]!, 'failed', 'RF1');
    await sweep();
    w.clock.advance(HOUR); // the second offer is later than the first
    const again = await resolve(
      { ...w.deps, requestRefund: requester(w, c.made) as never },
      { case_id: c.case_id, action: 'offer_refund', by: operator, reason: 'second try' },
    );
    expect(again.ok && again.value.state).toBe('refund_pending');
    // The new offer's request is the one the case follows, not the old failed one.
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refund_pending');
    await setRequest(c.made[1]!, 'completed', 'RF3');
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refunded');
  });

  it('only refund_pending cases move: an open case beside a completed request stays open', async () => {
    const it1 = await w.item(1);
    const c = await openCase(w.deps, {
      kind: 'refund_requested',
      entitlement_id: it1.entitlement_id,
      opened_by: 'operator',
      actor: operator,
    });
    if (!c.ok) throw new Error('open failed');
    await w.insert('refund_requests', {
      id: 'rfr_x',
      unit_id: 'unt_1',
      capture_id: 'CAP1',
      amount_minor: 500,
      currency: 'USD',
      reason: 'x',
      requested_by: 'operator:opr_1',
      state: 'completed',
      refund_id: 'RFX',
    });
    await sweep();
    expect(await stateOf(c.value.case_id)).toBe('open');
  });

  it('a refunded or closed case is left alone by a later failed request', async () => {
    const c = await pendingCase([1]);
    await setRequest(c.made[0]!, 'completed', 'RF1');
    await sweep();
    await setRequest(c.made[0]!, 'failed', 'RF1');
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refunded');
  });

  it('a refund_pending case with no request ids on its offer waits (nothing to follow)', async () => {
    const c = await pendingCase([1], [], () => '');
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refund_pending');
  });

  it('ids that name no request, or another unit, are not followed', async () => {
    const c = await pendingCase([1], [], () => 'rfr_missing,,  ,not an id');
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refund_pending');
    expect(await alertsOf()).toEqual([]);
  });

  it('the sweep honours max_items', async () => {
    const a = await pendingCase([1]);
    const b = await pendingCase([2]);
    await setRequest(a.made[0]!, 'completed', 'RF1');
    await setRequest(b.made[0]!, 'completed', 'RF2');
    await applyAutomaticRules(w.deps, { max_items: 1 });
    const states = [await stateOf(a.case_id), await stateOf(b.case_id)].sort();
    expect(states).toEqual(['refund_pending', 'refunded']);
    await applyAutomaticRules(w.deps, { max_items: 1 });
    expect([await stateOf(a.case_id), await stateOf(b.case_id)]).toEqual(['refunded', 'refunded']);
  });

  it('an unrelated alert opens a case in the same sweep; the refund rule shares the budget', async () => {
    const c = await pendingCase([1]);
    await setRequest(c.made[0]!, 'completed', 'RF1');
    const it2 = await w.item(2);
    await w.rawAlert({ kind: 'frozen_order', order_id: it2.order_id });
    const r = await sweep();
    expect(r.opened).toBe(1);
    expect(await stateOf(c.case_id)).toBe('refunded');
  });
});

// D-020 with recovery cases: a case locks the case row, then (credit) the entitlement. The refund
// rule locks the case and reads refund requests without locking them, so it never holds a case
// while waiting for a unit or an order.
const RANK: Record<string, number> = {
  orders: 1,
  operations: 2,
  order_units: 3,
  refund_requests: 4,
  recovery_cases: 4.5,
  entitlements: 5,
  access_windows: 5,
  access_events: 5,
  access_links: 5,
  ledger_entries: 6,
  receipts: 6,
};
function lockTarget(sql: string): string | null {
  const s = sql.replace(/\s+/g, ' ').trim();
  const write = /^(?:UPDATE|INSERT INTO|DELETE FROM) (\w+)/i.exec(s);
  if (write !== null) return write[1]!.toLowerCase();
  if (!/ FOR UPDATE\b/i.test(s)) return null;
  return /FROM (\w+)/i.exec(s)?.[1]?.toLowerCase() ?? null;
}
describe('lock order with recovery cases (D-020)', () => {
  it('credit and the refund transitions lock in rank order', async () => {
    const log: { table: string; sql: string }[][] = [];
    const spyDeps = {
      ...w.deps,
      db: {
        ...w.db,
        transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) => {
          const rec: { table: string; sql: string }[] = [];
          log.push(rec);
          return w.db.transaction((tx) =>
            fn({
              query: (sql: string, params?: unknown[]) => {
                const t = lockTarget(sql);
                if (t !== null) rec.push({ table: t, sql: sql.replace(/\s+/g, ' ').slice(0, 100) });
                return tx.query(sql, params);
              },
              exec: (sql: string) => tx.exec(sql),
            } as SqlExecutor),
          );
        },
      },
    } as unknown as typeof w.deps;

    const credit = await w.item(3);
    const dc = await openCase(spyDeps, {
      kind: 'delivery_failed',
      entitlement_id: credit.entitlement_id,
      opened_by: 'operator',
      actor: operator,
    });
    if (!dc.ok) throw new Error('open failed');
    w.clock.advance(HOUR);
    const granted = await resolve(spyDeps, {
      case_id: dc.value.case_id,
      action: 'credit',
      credit_ms: HOUR,
      by: operator,
      reason: 'slow',
    });
    expect(granted.ok).toBe(true);

    const made: string[] = [];
    const it1 = await w.item(1);
    const rc = await openCase(spyDeps, {
      kind: 'refund_requested',
      entitlement_id: it1.entitlement_id,
      opened_by: 'operator',
      actor: operator,
    });
    if (!rc.ok) throw new Error('open failed');
    const offered = await resolve(
      { ...spyDeps, requestRefund: requester(w, made) as never },
      { case_id: rc.value.case_id, action: 'offer_refund', by: operator, reason: 'x' },
    );
    expect(offered.ok).toBe(true);
    await setRequest(made[0]!, 'completed', 'RFL');
    await applyAutomaticRules(spyDeps, { max_items: 10 });
    expect(await stateOf(rc.value.case_id)).toBe('refunded');

    const it2 = await w.item(2);
    const fc = await openCase(spyDeps, {
      kind: 'refund_requested',
      entitlement_id: it2.entitlement_id,
      opened_by: 'operator',
      actor: operator,
    });
    if (!fc.ok) throw new Error('open failed');
    await resolve(
      { ...spyDeps, requestRefund: requester(w, made) as never },
      { case_id: fc.value.case_id, action: 'offer_refund', by: operator, reason: 'x' },
    );
    await setRequest(made[1]!, 'failed', 'RFM');
    await applyAutomaticRules(spyDeps, { max_items: 10 });
    expect(await stateOf(fc.value.case_id)).toBe('diagnosing');

    const bad: string[] = [];
    for (const tx of log) {
      const held = new Map<number, string>();
      for (const l of tx) {
        const r = RANK[l.table];
        if (r === undefined || held.has(r)) continue;
        const above = [...held.entries()].filter(([k]) => k > r);
        if (above.length > 0) bad.push(`${l.table}(${r}) after rank ${above[0]![0]} by [${l.sql}]`);
        held.set(r, l.sql);
      }
    }
    expect(log.some((tx) => tx.some((l) => l.table === 'recovery_cases'))).toBe(true);
    expect(log.some((tx) => tx.some((l) => l.table === 'entitlements'))).toBe(true);
    expect(bad).toEqual([]);
  });
});
