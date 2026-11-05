// BR-4: a buyer cannot open a refund_requested case after the refund deadline of the sale's frozen terms.
// The deadline is the access start plus refund.request_window days (the capture time when access has not
// started); the window is open strictly before it. Before it, opening is unchanged. An operator or the
// system opening the case is not held to the deadline (an operator refund has its own override). A sale
// approved before the terms were recorded (version 1) has no deadline; a version 2 snapshot without usable
// terms is refused, never treated as "no deadline". Real PGlite, synthetic rows.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openCase } from './index';
import { makeWorld } from './world';
import type { World } from './world';

const DAY = 86_400_000;
const START = '2026-11-01T10:00:00.000Z';
const at = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();
const DEADLINE = at(START, 7 * DAY);
const buyer1 = { kind: 'buyer', buyer_id: 'buy_1' } as const;
const operator = { kind: 'operator', operator_id: 'opr_1', mfa: true } as const;

function terms(refundDays: number) {
  return {
    rules_version: '1',
    values: {
      'refund.request_window': refundDays,
      'access.window': Math.max(refundDays, 1),
      'mandate.max_days': 90,
    },
    sources: {
      'refund.request_window': 'default',
      'access.window': 'default',
      'mandate.max_days': 'default',
    },
    digest: 'a'.repeat(64),
  };
}
const v2 = (refundDays = 7) => ({ snapshot_version: '2', terms: terms(refundDays) });

let w: World;
beforeAll(async () => {
  w = await makeWorld('rcw');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
  w.clock.set(START);
});

const ask = (
  entitlement_id: string,
  o: { opened_by?: 'buyer' | 'operator'; kind?: 'refund_requested' | 'delivery_failed' } = {},
) =>
  openCase(w.deps, {
    kind: o.kind ?? 'refund_requested',
    entitlement_id,
    opened_by: o.opened_by ?? 'buyer',
    actor: (o.opened_by ?? 'buyer') === 'buyer' ? buyer1 : operator,
  });

describe('a buyer opens a refund case against the frozen window', () => {
  it('is allowed one millisecond before the deadline', async () => {
    const item = await w.item(1, { snapshot: v2() });
    w.clock.set(at(DEADLINE, -1));
    const r = await ask(item.entitlement_id);
    expect(r.ok).toBe(true);
  });

  it('is refused at exactly the deadline', async () => {
    const item = await w.item(1, { snapshot: v2() });
    w.clock.set(DEADLINE);
    expect(await ask(item.entitlement_id)).toEqual({
      ok: false,
      error: { code: 'refund_window_closed' },
    });
  });

  it('is refused after the deadline, and no case is stored', async () => {
    const item = await w.item(1, { snapshot: v2() });
    w.clock.set(at(DEADLINE, 5 * DAY));
    expect(await ask(item.entitlement_id)).toEqual({
      ok: false,
      error: { code: 'refund_window_closed' },
    });
    const rows = await w.db.query('SELECT 1 FROM recovery_cases');
    expect(rows.rows).toHaveLength(0);
  });

  it('is allowed well before the deadline', async () => {
    const item = await w.item(1, { snapshot: v2() });
    w.clock.set(at(START, 2 * DAY));
    expect((await ask(item.entitlement_id)).ok).toBe(true);
  });

  it('follows a frozen window of one day and of thirty days', async () => {
    const one = await w.item(1, { snapshot: v2(1) });
    w.clock.set(at(START, DAY));
    expect(await ask(one.entitlement_id)).toEqual({
      ok: false,
      error: { code: 'refund_window_closed' },
    });
    const thirty = await w.item(2, { snapshot: v2(30) });
    w.clock.set(at(START, 29 * DAY));
    expect((await ask(thirty.entitlement_id)).ok).toBe(true);
  });

  it('counts from the access start, which is the time the item became ready', async () => {
    const item = await w.item(1, { snapshot: v2() });
    const started = (
      await w.db.query<{ started_at: string | Date }>(
        'SELECT started_at FROM access_windows WHERE entitlement_id = $1',
        [item.entitlement_id],
      )
    ).rows[0]!.started_at;
    expect(new Date(started).toISOString()).toBe(START);
  });

  it('counts from the verified capture time when access has not started', async () => {
    const item = await w.item(1, { snapshot: v2(), ready: false });
    await w.db.query('UPDATE order_units SET captured_verified_at = $2 WHERE id = $1', [
      item.unit_id,
      at(START, -3 * DAY),
    ]);
    w.clock.set(at(START, 4 * DAY - 1));
    expect((await ask(item.entitlement_id)).ok).toBe(true);
    await w.reset();
    const again = await w.item(1, { snapshot: v2(), ready: false });
    await w.db.query('UPDATE order_units SET captured_verified_at = $2 WHERE id = $1', [
      again.unit_id,
      at(START, -3 * DAY),
    ]);
    w.clock.set(at(START, 4 * DAY));
    expect(await ask(again.entitlement_id)).toEqual({
      ok: false,
      error: { code: 'refund_window_closed' },
    });
  });
});

describe('who and what the deadline applies to', () => {
  it('does not stop an operator opening the case after the deadline', async () => {
    const item = await w.item(1, { snapshot: v2() });
    w.clock.set(at(DEADLINE, 3 * DAY));
    expect((await ask(item.entitlement_id, { opened_by: 'operator' })).ok).toBe(true);
  });

  it('does not touch other kinds of case after the deadline', async () => {
    const item = await w.item(1, { snapshot: v2() });
    w.clock.set(at(DEADLINE, 3 * DAY));
    expect((await ask(item.entitlement_id, { kind: 'delivery_failed' })).ok).toBe(true);
  });

  it('has no deadline for a version 1 sale', async () => {
    const item = await w.item(1);
    w.clock.set(at(START, 400 * DAY));
    expect((await ask(item.entitlement_id)).ok).toBe(true);
  });

  it('refuses a version 2 snapshot with no terms, even before the would-be deadline', async () => {
    const item = await w.item(1, { snapshot: { snapshot_version: '2' } });
    w.clock.set(at(START, DAY));
    expect(await ask(item.entitlement_id)).toEqual({
      ok: false,
      error: { code: 'refund_window_closed' },
    });
  });

  it('keeps answering not_found for another buyer before it reads any deadline', async () => {
    const item = await w.item(1, { snapshot: v2() });
    w.clock.set(at(DEADLINE, DAY));
    const r = await openCase(w.deps, {
      kind: 'refund_requested',
      entitlement_id: item.entitlement_id,
      opened_by: 'buyer',
      actor: { kind: 'buyer', buyer_id: 'buy_2' },
    });
    expect(r).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('keeps answering duplicate_open for a second open case inside the window', async () => {
    const item = await w.item(1, { snapshot: v2() });
    expect((await ask(item.entitlement_id)).ok).toBe(true);
    expect(await ask(item.entitlement_id)).toEqual({
      ok: false,
      error: { code: 'duplicate_open' },
    });
  });

  it('an order-level case is open while any unit of the order is inside its window', async () => {
    const item = await w.item(1, { snapshot: v2() });
    w.clock.set(at(DEADLINE, -DAY));
    const open = await openCase(w.deps, {
      kind: 'refund_requested',
      order_id: item.order_id,
      opened_by: 'buyer',
      actor: buyer1,
    });
    expect(open.ok).toBe(true);
  });

  it('an order-level case is refused when every unit of the order is past its window', async () => {
    const item = await w.item(1, { snapshot: v2() });
    w.clock.set(DEADLINE);
    const r = await openCase(w.deps, {
      kind: 'refund_requested',
      order_id: item.order_id,
      opened_by: 'buyer',
      actor: buyer1,
    });
    expect(r).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
  });
});
