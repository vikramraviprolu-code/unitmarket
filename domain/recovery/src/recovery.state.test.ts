import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordDeliveryEvent } from '@umsbx/access-clock';
import { getEntitlementForBuyer } from '@umsbx/entitlements';
import { applyAutomaticRules, diagnose, listCasesForBuyer, openCase, resolve } from './index';
import { HOUR, makeWorld } from './world';
import type { World } from './world';

const buyer1 = { kind: 'buyer', buyer_id: 'buy_1' } as const;
const operator = { kind: 'operator', operator_id: 'opr_1', mfa: true } as const;
const system = { kind: 'system' } as const;

let w: World;
beforeAll(async () => {
  w = await makeWorld('rec');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
  w.clock.set('2026-10-21T10:00:00.000Z');
});

const fail = (entitlement_id: string) =>
  recordDeliveryEvent(w.deps, {
    entitlement_id,
    kind: 'delivery_failed',
    link_id: null,
    source: 'system',
    evidence: { reason: 'store_unavailable' },
  });
const windowOf = async (entitlement_id: string) =>
  (await getEntitlementForBuyer(w.db, { entitlement_id, buyer_id: 'buy_1' }))?.window;
const actions = async (case_id: string) =>
  (
    await w.db.query<{ action: string; actor: string }>(
      'SELECT action, actor FROM recovery_actions WHERE case_id = $1 ORDER BY created_at, ctid',
      [case_id],
    )
  ).rows;

describe('delivery failure (A-18)', () => {
  it('opens a system case; the measured credit closes it as restored and the window carries it', async () => {
    const it1 = await w.item(1);
    w.clock.advance(HOUR);
    await fail(it1.entitlement_id);
    expect((await windowOf(it1.entitlement_id))?.state).toBe('paused');

    expect(await applyAutomaticRules(w.deps, { max_items: 10 })).toEqual({
      opened: 1,
      restored: 0,
    });
    const open = await listCasesForBuyer(w.db, { buyer_id: 'buy_1' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: 'delivery_failed',
      state: 'open',
      entitlement_id: it1.entitlement_id,
      order_id: it1.order_id,
      opened_by: 'system',
      credit_ms: 0,
    });
    // The same failure never opens a second case.
    expect(await applyAutomaticRules(w.deps, { max_items: 10 })).toEqual({
      opened: 0,
      restored: 0,
    });

    // Delivery comes back 2 h 20 min later: the clock credits 3 h (rounded up to the hour).
    w.clock.advance(2 * HOUR + 20 * 60_000);
    await recordDeliveryEvent(w.deps, {
      entitlement_id: it1.entitlement_id,
      kind: 'delivery_restored',
      link_id: null,
      source: 'system',
      evidence: { probe: 'ok' },
    });
    expect(await applyAutomaticRules(w.deps, { max_items: 10 })).toEqual({
      opened: 0,
      restored: 1,
    });
    const after = await listCasesForBuyer(w.db, { buyer_id: 'buy_1' });
    expect(after[0]).toMatchObject({ state: 'restored', credit_ms: 3 * HOUR });
    expect(after[0]?.buyer_message).toBe(
      'We could not deliver your copy for 3 hours. We added 3 hours to your access.',
    );
    const win = await windowOf(it1.entitlement_id);
    expect(win?.state).toBe('running');
    expect(win?.credit_ms).toBe(3 * HOUR);
    expect(await applyAutomaticRules(w.deps, { max_items: 10 })).toEqual({
      opened: 0,
      restored: 0,
    });
    expect((await actions(after[0]?.case_id ?? '')).map((a) => a.action)).toEqual([
      'opened',
      'auto_restored',
    ]);
  });

  it('a later failure of the same item opens a new case once the first is resolved', async () => {
    const it1 = await w.item(1);
    await fail(it1.entitlement_id);
    await applyAutomaticRules(w.deps, { max_items: 10 });
    w.clock.advance(HOUR);
    await recordDeliveryEvent(w.deps, {
      entitlement_id: it1.entitlement_id,
      kind: 'delivery_restored',
      link_id: null,
      source: 'system',
      evidence: {},
    });
    await applyAutomaticRules(w.deps, { max_items: 10 });
    w.clock.advance(HOUR);
    await fail(it1.entitlement_id);
    expect(await applyAutomaticRules(w.deps, { max_items: 10 })).toEqual({
      opened: 1,
      restored: 0,
    });
    expect(await listCasesForBuyer(w.db, { buyer_id: 'buy_1' })).toHaveLength(2);
  });

  it('max_items bounds the work of one run', async () => {
    for (const n of [1, 2, 3]) {
      const x = await w.item(n);
      await fail(x.entitlement_id);
    }
    expect(await applyAutomaticRules(w.deps, { max_items: 2 })).toEqual({ opened: 2, restored: 0 });
    expect(await applyAutomaticRules(w.deps, { max_items: 2 })).toEqual({ opened: 1, restored: 0 });
  });

  it('restore by an operator issues a fresh free link and records delivery_restored', async () => {
    const it1 = await w.item(1);
    await fail(it1.entitlement_id);
    await applyAutomaticRules(w.deps, { max_items: 10 });
    const [c] = await listCasesForBuyer(w.db, { buyer_id: 'buy_1' });
    w.clock.advance(5 * HOUR + 1);
    const links0 = await w.count('links');
    const r = await resolve(w.deps, {
      case_id: c?.case_id ?? '',
      action: 'restore',
      by: operator,
      reason: 'store repaired',
    });
    expect(r.ok && r.value).toMatchObject({ state: 'restored', credit_ms: 6 * HOUR });
    expect(await w.count('links')).toBe(links0 + 1);
    const kinds = (
      await w.db.query<{ kind: string }>(
        'SELECT kind FROM access_events WHERE entitlement_id = $1 ORDER BY at, ctid',
        [it1.entitlement_id],
      )
    ).rows.map((e) => e.kind);
    expect(kinds).toEqual(['access_ready', 'delivery_failed', 'link_issued', 'delivery_restored']);
    expect((await windowOf(it1.entitlement_id))?.credit_ms).toBe(6 * HOUR);
    // Resolved already: a second resolve is a wrong_state.
    expect(
      await resolve(w.deps, {
        case_id: c?.case_id ?? '',
        action: 'restore',
        by: operator,
        reason: 'x',
      }),
    ).toEqual({ ok: false, error: { code: 'wrong_state' } });
  });

  it('restore refuses while the store still fails, and leaves the case open', async () => {
    const it1 = await w.item(1);
    await fail(it1.entitlement_id);
    await applyAutomaticRules(w.deps, { max_items: 10 });
    await w.breakContent(1);
    const [c] = await listCasesForBuyer(w.db, { buyer_id: 'buy_1' });
    const r = await resolve(w.deps, {
      case_id: c?.case_id ?? '',
      action: 'restore',
      by: operator,
      reason: 'try',
    });
    expect(r).toEqual({ ok: false, error: { code: 'wrong_state' } });
    expect((await listCasesForBuyer(w.db, { buyer_id: 'buy_1' }))[0]?.state).toBe('open');
    expect((await windowOf(it1.entitlement_id))?.state).toBe('paused');
  });
});

describe('credit', () => {
  it('by an operator extends ends_at; by the buyer is refused and changes nothing', async () => {
    const it1 = await w.item(1);
    const before = await windowOf(it1.entitlement_id);
    const opened = await openCase(w.deps, {
      kind: 'delivery_failed',
      entitlement_id: it1.entitlement_id,
      opened_by: 'buyer',
      actor: buyer1,
      note: 'link did not open',
    });
    if (!opened.ok) throw new Error('open failed');
    const refused = await resolve(w.deps, {
      case_id: opened.value.case_id,
      action: 'credit',
      credit_ms: 2 * HOUR,
      by: buyer1,
      reason: 'give me time',
    });
    expect(refused).toEqual({ ok: false, error: { code: 'not_operator' } });
    expect(await windowOf(it1.entitlement_id)).toEqual(before);

    const granted = await resolve(w.deps, {
      case_id: opened.value.case_id,
      action: 'credit',
      credit_ms: 2 * HOUR,
      by: operator,
      reason: 'service slow',
    });
    expect(granted.ok && granted.value).toMatchObject({ state: 'restored', credit_ms: 2 * HOUR });
    const after = await windowOf(it1.entitlement_id);
    expect(Date.parse(after?.ends_at ?? '') - Date.parse(before?.ends_at ?? '')).toBe(2 * HOUR);
    expect(granted.ok && granted.value.buyer_message).toBe(
      'We added 2 hours to your access. Sorry for the trouble.',
    );
  });

  it('needs a positive credit_ms and a live window', async () => {
    const it1 = await w.item(1);
    const it2 = await w.item(2);
    const c1 = await openCase(w.deps, {
      kind: 'delivery_failed',
      entitlement_id: it1.entitlement_id,
      opened_by: 'operator',
      actor: operator,
    });
    if (!c1.ok) throw new Error('open failed');
    for (const credit_ms of [undefined, 0, -5, 1.5]) {
      const r = await resolve(w.deps, {
        case_id: c1.value.case_id,
        action: 'credit',
        ...(credit_ms !== undefined ? { credit_ms } : {}),
        by: operator,
        reason: 'x',
      });
      expect(r).toEqual({ ok: false, error: { code: 'wrong_state' } });
    }
    // A window that already ended takes no credit.
    const c2 = await openCase(w.deps, {
      kind: 'delivery_failed',
      entitlement_id: it2.entitlement_id,
      opened_by: 'operator',
      actor: operator,
    });
    if (!c2.ok) throw new Error('open failed');
    w.clock.advance(6 * 24 * HOUR);
    const late = await resolve(w.deps, {
      case_id: c2.value.case_id,
      action: 'credit',
      credit_ms: HOUR,
      by: operator,
      reason: 'late',
    });
    expect(late).toEqual({ ok: false, error: { code: 'wrong_state' } });
  });
});

describe('closing without a charge', () => {
  it('close_not_charged is refused when a capture is verified', async () => {
    const it1 = await w.item(1);
    const c = await openCase(w.deps, {
      kind: 'payment_unresolved',
      order_id: it1.order_id,
      opened_by: 'system',
      actor: system,
    });
    if (!c.ok) throw new Error('open failed');
    const r = await resolve(w.deps, {
      case_id: c.value.case_id,
      action: 'close_not_charged',
      by: operator,
      reason: 'looks failed',
    });
    expect(r).toEqual({ ok: false, error: { code: 'wrong_state' } });
    expect((await listCasesForBuyer(w.db, { buyer_id: 'buy_1' }))[0]?.state).toBe('open');
  });

  it('close_not_charged closes an order that has no verified capture', async () => {
    const it1 = await w.item(1, { unit_status: 'declined' });
    const c = await openCase(w.deps, {
      kind: 'payment_unresolved',
      order_id: it1.order_id,
      opened_by: 'system',
      actor: system,
    });
    if (!c.ok) throw new Error('open failed');
    const r = await resolve(w.deps, {
      case_id: c.value.case_id,
      action: 'close_not_charged',
      by: operator,
      reason: 'read-back shows no capture',
    });
    expect(r.ok && r.value).toMatchObject({ state: 'closed_not_charged' });
    expect(r.ok && r.value.buyer_message).toBe('You were not charged. Nothing more is needed.');
  });

  it('close_no_fault shows the reason to the buyer', async () => {
    const it1 = await w.item(1);
    const c = await openCase(w.deps, {
      kind: 'delivery_failed',
      entitlement_id: it1.entitlement_id,
      opened_by: 'buyer',
      actor: buyer1,
    });
    if (!c.ok) throw new Error('open failed');
    const r = await resolve(w.deps, {
      case_id: c.value.case_id,
      action: 'close_no_fault',
      by: operator,
      reason: 'The download finished on our side at 10:05.',
    });
    expect(r.ok && r.value.state).toBe('closed_no_fault');
    expect(r.ok && r.value.buyer_message).toBe(
      'We checked and found no fault. The download finished on our side at 10:05.',
    );
  });
});

describe('refund offer', () => {
  it('goes through requestRefund as an operator and waits for the read-back', async () => {
    const it1 = await w.item(1);
    const c = await openCase(w.deps, {
      kind: 'refund_requested',
      entitlement_id: it1.entitlement_id,
      opened_by: 'buyer',
      actor: buyer1,
    });
    if (!c.ok) throw new Error('open failed');
    const calls: unknown[] = [];
    const deps = {
      ...w.deps,
      requestRefund: (i: unknown) => {
        calls.push(i);
        return Promise.resolve({ ok: true as const, value: { refund_request_id: 'rfr_1' } });
      },
    };
    expect(
      await resolve(deps, {
        case_id: c.value.case_id,
        action: 'offer_refund',
        by: buyer1,
        reason: 'x',
      }),
    ).toEqual({ ok: false, error: { code: 'not_operator' } });
    expect(calls).toHaveLength(0);
    const r = await resolve(deps, {
      case_id: c.value.case_id,
      action: 'offer_refund',
      by: operator,
      reason: 'buyer asked within the window',
    });
    expect(r.ok && r.value.state).toBe('refund_pending');
    expect(calls).toEqual([
      {
        unit_id: it1.unit_id,
        amount: null,
        reason: 'buyer asked within the window',
        actor: operator,
      },
    ]);
  });

  it('is refused when no refund path is wired or the refund path refuses', async () => {
    const it1 = await w.item(1);
    const c = await openCase(w.deps, {
      kind: 'refund_requested',
      entitlement_id: it1.entitlement_id,
      opened_by: 'operator',
      actor: operator,
    });
    if (!c.ok) throw new Error('open failed');
    const none = await resolve(w.deps, {
      case_id: c.value.case_id,
      action: 'offer_refund',
      by: operator,
      reason: 'x',
    });
    expect(none).toEqual({ ok: false, error: { code: 'wrong_state' } });
    const off = await resolve(
      {
        ...w.deps,
        requestRefund: () =>
          Promise.resolve({ ok: false as const, error: { code: 'refunds_off' } }),
      },
      { case_id: c.value.case_id, action: 'offer_refund', by: operator, reason: 'x' },
    );
    expect(off).toEqual({ ok: false, error: { code: 'wrong_state' } });
    expect((await listCasesForBuyer(w.db, { buyer_id: 'buy_1' }))[0]?.state).toBe('open');
  });
});

describe('opening', () => {
  it('allows one open case per kind and item', async () => {
    const it1 = await w.item(1);
    const open = (kind: 'delivery_failed' | 'refund_requested') =>
      openCase(w.deps, {
        kind,
        entitlement_id: it1.entitlement_id,
        opened_by: 'buyer',
        actor: buyer1,
      });
    const first = await open('delivery_failed');
    expect(first.ok).toBe(true);
    expect(await open('delivery_failed')).toEqual({ ok: false, error: { code: 'duplicate_open' } });
    expect((await open('refund_requested')).ok).toBe(true);
    // Resolved cases free the slot.
    if (!first.ok) throw new Error('unreachable');
    await resolve(w.deps, {
      case_id: first.value.case_id,
      action: 'close_no_fault',
      by: operator,
      reason: 'checked',
    });
    expect((await open('delivery_failed')).ok).toBe(true);
    expect(await w.count('recovery_cases')).toBe(3);
  });

  it('keys an order-level case on the order', async () => {
    const it1 = await w.item(1);
    const o = () =>
      openCase(w.deps, {
        kind: 'frozen_order',
        order_id: it1.order_id,
        opened_by: 'system',
        actor: system,
      });
    expect((await o()).ok).toBe(true);
    expect(await o()).toEqual({ ok: false, error: { code: 'duplicate_open' } });
  });

  it('a buyer report with no system evidence waits for an operator', async () => {
    const it1 = await w.item(1);
    const c = await openCase(w.deps, {
      kind: 'delivery_failed',
      entitlement_id: it1.entitlement_id,
      opened_by: 'buyer',
      actor: buyer1,
      note: 'cannot open',
    });
    expect(c.ok && c.value).toMatchObject({ state: 'open', opened_by: 'buyer', credit_ms: 0 });
    expect(await applyAutomaticRules(w.deps, { max_items: 10 })).toEqual({
      opened: 0,
      restored: 0,
    });
    expect((await listCasesForBuyer(w.db, { buyer_id: 'buy_1' }))[0]?.state).toBe('open');
    expect(c.ok && c.value.buyer_message).toBe(
      'We got your report and are looking into it. You do not need to do anything else.',
    );
  });

  it('refuses a case that names neither an order nor an item, or a mismatched pair', async () => {
    const it1 = await w.item(1);
    const it2 = await w.item(2);
    const none = await openCase(w.deps, {
      kind: 'delivery_failed',
      opened_by: 'operator',
      actor: operator,
    });
    expect(none).toEqual({ ok: false, error: { code: 'not_found' } });
    const mismatch = await openCase(w.deps, {
      kind: 'delivery_failed',
      order_id: it2.order_id,
      entitlement_id: it1.entitlement_id,
      opened_by: 'operator',
      actor: operator,
    });
    expect(mismatch).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('opened_by must match the actor; a buyer cannot open system kinds', async () => {
    const it1 = await w.item(1);
    const base = { kind: 'delivery_failed', entitlement_id: it1.entitlement_id } as const;
    expect(await openCase(w.deps, { ...base, opened_by: 'system', actor: buyer1 })).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
    expect(await openCase(w.deps, { ...base, opened_by: 'operator', actor: buyer1 })).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
    expect(
      await openCase(w.deps, {
        kind: 'reversal',
        order_id: it1.order_id,
        opened_by: 'buyer',
        actor: buyer1,
      }),
    ).toEqual({ ok: false, error: { code: 'not_operator' } });
    expect(await w.count('recovery_cases')).toBe(0);
  });
});

describe('alerts become cases', () => {
  it('opens one case per new alert of the four kinds, once', async () => {
    const a = await w.item(1);
    const b = await w.item(2);
    const c = await w.item(3);
    const e = await w.item(4);
    await w.rawAlert({ kind: 'frozen_order', order_id: a.order_id, reason: 'mismatch' });
    await w.rawAlert({
      kind: 'payment_unresolved',
      order_id: b.order_id,
      reason: 'window_expired',
    });
    await w.rawAlert({
      kind: 'reversal',
      order_id: c.order_id,
      unit_id: c.unit_id,
      reason: 'event',
    });
    await w.rawAlert({ kind: 'partial_composite', order_id: e.order_id, reason: 'one_declined' });
    // Kinds payments raises for other reasons never become cases.
    await w.rawAlert({ kind: 'content_unavailable', order_id: a.order_id, reason: 'store' });
    expect(await applyAutomaticRules(w.deps, { max_items: 10 })).toEqual({
      opened: 4,
      restored: 0,
    });
    expect(await applyAutomaticRules(w.deps, { max_items: 10 })).toEqual({
      opened: 0,
      restored: 0,
    });
    const kinds = (
      await w.db.query<{ kind: string; opened_by: string; state: string }>(
        'SELECT kind, opened_by, state FROM recovery_cases ORDER BY kind',
      )
    ).rows;
    expect(kinds).toEqual([
      { kind: 'frozen_order', opened_by: 'system', state: 'open' },
      { kind: 'partial_composite', opened_by: 'system', state: 'open' },
      { kind: 'payment_unresolved', opened_by: 'system', state: 'open' },
      { kind: 'reversal', opened_by: 'system', state: 'open' },
    ]);
  });

  it('a reversal_hint alert (an unproven webhook, ASM-63) never becomes a case or a buyer message', async () => {
    const c = await w.item(3);
    await w.rawAlert({
      kind: 'reversal_hint',
      order_id: c.order_id,
      unit_id: c.unit_id,
      reason: 'reversal_hint',
    });
    expect(await applyAutomaticRules(w.deps, { max_items: 10 })).toEqual({
      opened: 0,
      restored: 0,
    });
    expect(await w.count('recovery_cases')).toBe(0);
    expect(await listCasesForBuyer(w.db, { buyer_id: 'buy_1' })).toEqual([]);
    // The read evidence (kind reversal) still opens the case.
    await w.rawAlert({
      kind: 'reversal',
      order_id: c.order_id,
      unit_id: c.unit_id,
      reason: 'reversal_suspected',
    });
    expect(await applyAutomaticRules(w.deps, { max_items: 10 })).toEqual({
      opened: 1,
      restored: 0,
    });
    expect(await listCasesForBuyer(w.db, { buyer_id: 'buy_1' })).toHaveLength(1);
  });

  it('a second alert for an order that already has an open case of that kind joins it', async () => {
    const a = await w.item(1);
    await w.rawAlert({ kind: 'frozen_order', order_id: a.order_id, reason: 'mismatch' });
    await applyAutomaticRules(w.deps, { max_items: 10 });
    await w.rawAlert({ kind: 'frozen_order', order_id: a.order_id, reason: 'amount' });
    expect(await applyAutomaticRules(w.deps, { max_items: 10 })).toEqual({
      opened: 0,
      restored: 0,
    });
    expect(await w.count('recovery_cases')).toBe(1);
    expect(await applyAutomaticRules(w.deps, { max_items: 10 })).toEqual({
      opened: 0,
      restored: 0,
    });
    const linked = await w.db.query("SELECT 1 FROM recovery_actions WHERE action = 'alert_linked'");
    expect(linked.rows).toHaveLength(1);
  });

  it('a frozen-order case speaks plainly and never claims a double charge', async () => {
    const a = await w.item(1);
    await w.rawAlert({ kind: 'frozen_order', order_id: a.order_id });
    await applyAutomaticRules(w.deps, { max_items: 10 });
    const [c] = await listCasesForBuyer(w.db, { buyer_id: 'buy_1' });
    expect(c?.buyer_message).toBe(
      'Your order is on hold while we check it. You have not been charged twice. We will write to you.',
    );
  });
});

describe('diagnose and bookkeeping', () => {
  it('gathers evidence, the window and the order status, and moves open to diagnosing', async () => {
    const it1 = await w.item(1);
    await fail(it1.entitlement_id);
    await applyAutomaticRules(w.deps, { max_items: 10 });
    const [c] = await listCasesForBuyer(w.db, { buyer_id: 'buy_1' });
    const d = await diagnose(w.deps, { case_id: c?.case_id ?? '' });
    expect(d.evidence.map((e) => e.kind)).toEqual(['access_ready', 'delivery_failed']);
    expect(d.window?.state).toBe('paused');
    expect(d.order_status).toBe('paid');
    expect((await listCasesForBuyer(w.db, { buyer_id: 'buy_1' }))[0]?.state).toBe('diagnosing');
    expect(await diagnose(w.deps, { case_id: 'cas_missing' })).toEqual({
      evidence: [],
      window: null,
      order_status: null,
    });
    // Diagnosing cases still count as open for the duplicate rule and resolve normally.
    expect(
      await openCase(w.deps, {
        kind: 'delivery_failed',
        entitlement_id: it1.entitlement_id,
        opened_by: 'operator',
        actor: operator,
      }),
    ).toEqual({ ok: false, error: { code: 'duplicate_open' } });
  });

  it('every action appends recovery_actions and audit_log', async () => {
    const it1 = await w.item(1);
    const c = await openCase(w.deps, {
      kind: 'delivery_failed',
      entitlement_id: it1.entitlement_id,
      opened_by: 'buyer',
      actor: buyer1,
    });
    if (!c.ok) throw new Error('open failed');
    await resolve(w.deps, {
      case_id: c.value.case_id,
      action: 'credit',
      credit_ms: HOUR,
      by: operator,
      reason: 'sorry',
    });
    expect(await actions(c.value.case_id)).toEqual([
      { action: 'opened', actor: 'buyer:buy_1' },
      { action: 'credit', actor: 'operator:opr_1' },
    ]);
    const audit = await w.db.query<{ action: string; target: string; reason: string | null }>(
      "SELECT action, target, reason FROM audit_log WHERE action LIKE 'recovery.%' ORDER BY created_at, ctid",
    );
    expect(audit.rows).toEqual([
      { action: 'recovery.opened', target: c.value.case_id, reason: null },
      { action: 'recovery.credit', target: c.value.case_id, reason: 'sorry' },
    ]);
    // The action log refuses edits (append-only table).
    await expect(w.db.query('DELETE FROM recovery_actions')).rejects.toThrow();
  });

  it('sets an SLA that differs by kind', async () => {
    const it1 = await w.item(1);
    await openCase(w.deps, {
      kind: 'payment_unresolved',
      order_id: it1.order_id,
      opened_by: 'system',
      actor: system,
    });
    await openCase(w.deps, {
      kind: 'delivery_failed',
      entitlement_id: it1.entitlement_id,
      opened_by: 'system',
      actor: system,
    });
    const rows = (
      await w.db.query<{ kind: string; due: number }>(
        `SELECT kind, extract(epoch FROM (sla_due_at - created_at)) * 1000 AS due FROM recovery_cases ORDER BY kind`,
      )
    ).rows;
    expect(rows.map((r) => r.kind)).toEqual(['delivery_failed', 'payment_unresolved']);
    expect(Number(rows[0]?.due)).toBeGreaterThan(Number(rows[1]?.due));
  });
});
