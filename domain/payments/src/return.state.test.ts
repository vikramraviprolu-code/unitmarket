// State tests of onBuyerReturn: the pre-capture check, the readiness probe, the one gated capture,
// the claim, the separate read-back and the unlock (steps 9 to 14). Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrderView, onBuyerReturn, requestIdFor } from './index';
import {
  BUYER_A,
  BUYER_B,
  FIVE_DAYS_MS,
  approved,
  awaiting,
  count,
  makeWorld,
  place,
  reapply,
  sha256Of,
} from './support';
import type { World } from './support';

let w: World;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const ret = (ref: string, scenario: string | null = null) =>
  onBuyerReturn(w.deps, { order_ref: ref, actor: BUYER_A, scenario });
const order = async (id: string) =>
  (
    await w.rows<{ status: string; mismatch: boolean }>(
      'SELECT status, mismatch FROM orders WHERE id = $1',
      [id],
    )
  )[0]!;
const unit = async (order_id: string) =>
  (
    await w.rows<Record<string, unknown>>('SELECT * FROM order_units WHERE order_id = $1', [
      order_id,
    ])
  )[0]!;
const ent = async () =>
  (await w.rows<Record<string, unknown>>('SELECT * FROM entitlements ORDER BY id'))[0]!;
const op = async (order_id: string, kind: string) =>
  (
    await w.rows<Record<string, unknown>>(
      'SELECT * FROM operations WHERE order_id = $1 AND kind = $2',
      [order_id, kind],
    )
  )[0];

describe('the verified journey', () => {
  it('A-12: matching read-back unlocks, starts the window now, books sale and fee, issues receipt v1', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.clock.advance(60_000);
    const r = await ret(a.order_ref);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('paid');
    expect(r.value.order_ref).toBe(a.order_ref);
    expect(r.value.environment).toBe('dryrun');
    expect(r.value.items).toHaveLength(1);
    expect(r.value.items[0]).toMatchObject({ article_id: 'art_1', access: 'available' });
    const now = w.clock.now().getTime();
    expect(Date.parse(r.value.items[0]!.window.started_at!)).toBe(now);
    expect(Date.parse(r.value.items[0]!.window.ends_at!)).toBe(now + FIVE_DAYS_MS);
    expect(r.value.items[0]!.window.state).toBe('running');

    const u = await unit(a.order_id);
    expect(u).toMatchObject({ status: 'captured_verified', paypal_fee_minor: 45 });
    expect(u.capture_id).toMatch(/^SBXFAKECAP/);
    expect(u.captured_verified_at).not.toBeNull();
    expect(await ent()).toMatchObject({
      money_state: 'captured',
      access_state: 'available',
      licence_state: 'granted',
    });

    const ledger = await w.rows<{ kind: string; amount_minor: number; capture_id: string }>(
      'SELECT kind, amount_minor, capture_id FROM ledger_entries ORDER BY kind',
    );
    expect(ledger).toEqual([
      { kind: 'paypal_fee', amount_minor: 45, capture_id: u.capture_id },
      { kind: 'sale', amount_minor: 400, capture_id: u.capture_id },
    ]);
    const receipts = await w.rows<{ version: number }>(
      'SELECT version FROM receipts WHERE order_id = $1',
      [a.order_id],
    );
    expect(receipts).toEqual([{ version: 1 }]);
    expect(await count(w, 'access_events', "kind = 'access_ready'")).toBe(1);

    expect((await order(a.order_id)).status).toBe('paid');
    expect(await op(a.order_id, 'capture')).toMatchObject({
      state: 'confirmed',
      request_id: requestIdFor('capture', a.order_ref),
    });
    // create, get (pre-capture), capture, get (read-back): four provider calls.
    expect(w.paypal.calls.map((c) => c.op)).toEqual(['create', 'get', 'capture', 'get']);
  });

  it('the capture carries the stored provider order id and the umsK key', async () => {
    w = await makeWorld();
    const a = await approved(w);
    await ret(a.order_ref);
    const cap = w.paypal.calls.find((c) => c.op === 'capture')!;
    expect(cap).toMatchObject({
      provider_order_id: a.provider_order_id,
      request_id: `umsK-${a.order_ref}`,
    });
  });

  it('returning again after payment answers from the database with no provider call', async () => {
    w = await makeWorld();
    const a = await approved(w);
    await ret(a.order_ref);
    const before = w.paypal.calls.length;
    const again = await ret(a.order_ref);
    expect(again.ok && again.value.status).toBe('paid');
    expect(w.paypal.calls.length).toBe(before);
  });

  it('a two-publisher order captured once unlocks every item', async () => {
    w = await makeWorld();
    const a = await approved(w, { offers: ['ofr_1', 'ofr_3'] });
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('paid');
    expect(r.ok && r.value.items.map((i) => i.access)).toEqual(['available', 'available']);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(2);
  });
});

describe('claims never unlock', () => {
  it('A-11: claim COMPLETED with the read-back unavailable stays locked', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.get.push('real', { kind: 'unavailable', retry_after_ms: null });
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('unresolved');
    expect(r.ok && r.value.items[0]).toMatchObject({ access: 'locked' });
    expect(await ent()).toMatchObject({
      money_state: 'pending',
      access_state: 'locked',
      licence_state: null,
    });
    // The claim is stored as a note on the unit; nothing is verified, booked or issued.
    const u = await unit(a.order_id);
    expect(u).toMatchObject({ status: 'expected', captured_verified_at: null });
    expect(u.capture_id).toMatch(/^SBXFAKECAP/);
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(await count(w, 'receipts')).toBe(0);
    expect(await count(w, 'access_events')).toBe(0);
    expect(w.paypal.count('capture')).toBe(1);
    // A read-back operation waits for the reconciler (lane 05b).
    expect(await op(a.order_id, 'readback')).toMatchObject({ state: 'unknown' });
    expect((await op(a.order_id, 'readback'))!.next_retry_at).not.toBeNull();
  });

  it.each([
    ['timeout', { kind: 'timeout' }],
    ['not_found', { kind: 'not_found', debug_id: null }],
    ['blocked', { kind: 'blocked', by: 'kill_switch' }],
  ] as const)(
    'claim COMPLETED with the read-back %s stays locked and books nothing',
    async (_n, fail) => {
      w = await makeWorld();
      const a = await approved(w);
      w.paypal.queue.get.push('real', fail);
      const r = await ret(a.order_ref);
      expect(r.ok && r.value.status).toBe('unresolved');
      expect(await ent()).toMatchObject({ money_state: 'pending', access_state: 'locked' });
      expect(await count(w, 'ledger_entries')).toBe(0);
      expect(await count(w, 'receipts')).toBe(0);
    },
  );

  it('claim COMPLETED but the read-back shows no capture on the unit: unresolved, locked', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === 2) {
        const o = w.paypal.orders.get(a.provider_order_id)!;
        o.capture = null;
      }
    };
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('unresolved');
    expect(await ent()).toMatchObject({ money_state: 'pending', access_state: 'locked' });
    expect(await count(w, 'ledger_entries')).toBe(0);
  });

  it('claim says COMPLETED but the read-back shows a different capture id: frozen, no sale', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === 2) w.paypal.tamper = { capture_id: 'SBXOTHERCAP9' };
    };
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('frozen');
    expect((await unit(a.order_id)).status).toBe('mismatch');
    expect(await ent()).toMatchObject({ money_state: 'pending', access_state: 'locked' });
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(await count(w, 'alerts', "kind = 'frozen_order'")).toBe(1);
  });

  it('the capture id of another order is never stored twice: frozen, nothing booked', async () => {
    w = await makeWorld();
    const a = await approved(w);
    const b = await approved(w, { buyer_id: 'buy_B', actor: BUYER_B });
    await ret(a.order_ref);
    // Order B's provider order later claims the capture id of order A.
    const capA = (await unit(a.order_id)).capture_id as string;
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === 4) w.paypal.tamper = { capture_id: capA };
    };
    const r = await onBuyerReturn(w.deps, { order_ref: b.order_ref, actor: BUYER_B });
    expect(r.ok && r.value.status).toBe('frozen');
    expect(await count(w, 'ledger_entries', `unit_id = '${(await unit(b.order_id)).id}'`)).toBe(0);
    expect((await unit(b.order_id)).capture_id).not.toBe(capA);
  });

  it('A-16: PENDING with RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION stays locked and says so', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.next = {
      status: 'PENDING',
      reason: 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION',
      fee: null,
      lose_response: false,
    };
    const r = await ret(a.order_ref);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('unresolved');
    expect(r.value.items[0]!.access).toBe('locked');
    expect(r.value.buyer_message).toContain('pending');
    expect(r.value.buyer_message).toContain('RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION');
    expect(await unit(a.order_id)).toMatchObject({
      status: 'pending',
      status_reason: 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION',
    });
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(await ent()).toMatchObject({ money_state: 'pending', access_state: 'locked' });
  });

  it('claim DECLINED with a DECLINED read-back: unit declined, items denied, order failed, no sale', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.next = { status: 'DECLINED', reason: null, fee: null, lose_response: false };
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('failed');
    expect((await unit(a.order_id)).status).toBe('declined');
    expect(await ent()).toMatchObject({ money_state: 'denied', access_state: 'locked' });
    expect(await count(w, 'ledger_entries')).toBe(0);
  });
});

describe('P5: tampering with the read freezes, before or after the capture', () => {
  const cases = [
    ['amount +1', { amount_delta: 1 }],
    ['other payee', { payee: 'MERCHEVIL' }],
    ['EUR', { currency: 'EUR' }],
    ['other custom_id', { custom_id: 'ord_SOMEONEELSE' }],
  ] as const;

  it.each(cases)('A-13 before capture: %s freezes, nothing is captured', async (_n, tamper) => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.tamper = { ...tamper };
    const r = await ret(a.order_ref);
    expect(r).toEqual({ ok: false, error: { code: 'frozen' } });
    expect(w.paypal.count('capture')).toBe(0);
    expect((await order(a.order_id)).status).toBe('frozen');
    expect(await op(a.order_id, 'capture')).toBeUndefined();
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(await ent()).toMatchObject({ money_state: 'pending', access_state: 'locked' });
    expect(await count(w, 'alerts', "kind = 'frozen_order'")).toBeGreaterThanOrEqual(1);
  });

  it.each(cases)(
    'A-13 after capture: %s freezes with no sale and no unlock',
    async (_n, tamper) => {
      w = await makeWorld();
      const a = await approved(w);
      w.paypal.beforeGet = async () => {
        if (w.paypal.count('get') === 2) w.paypal.tamper = { ...tamper };
      };
      const r = await ret(a.order_ref);
      expect(r.ok && r.value.status).toBe('frozen');
      expect(r.ok && r.value.items[0]!.access).toBe('locked');
      expect(w.paypal.count('capture')).toBe(1);
      expect(await count(w, 'ledger_entries')).toBe(0);
      expect(await count(w, 'receipts')).toBe(0);
      expect(await ent()).toMatchObject({ money_state: 'pending', access_state: 'locked' });
      expect(await count(w, 'alerts', "kind = 'frozen_order'")).toBeGreaterThanOrEqual(1);
      expect((await order(a.order_id)).mismatch).toBe(true);
    },
  );

  it('a frozen order answers frozen on every later return, with no provider call', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.tamper = { amount_delta: 1 };
    await ret(a.order_ref);
    const calls = w.paypal.calls.length;
    for (let i = 0; i < 3; i += 1)
      expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'frozen' } });
    expect(w.paypal.calls.length).toBe(calls);
  });

  it('an extra unit and a dropped unit freeze before capture', async () => {
    for (const tamper of [{ extra_unit: true }, { drop_unit: true }]) {
      w = await makeWorld();
      const a = await approved(w);
      w.paypal.tamper = tamper;
      expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'frozen' } });
      expect(w.paypal.count('capture')).toBe(0);
      await w.close();
    }
    w = await makeWorld();
  });

  it('a capture already present on an APPROVED order freezes before capture', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.orders.get(a.provider_order_id)!.capture = {
      capture_id: 'SBXPRE1',
      status: 'COMPLETED',
      reason: null,
      fee: 1,
    };
    expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'frozen' } });
    expect(w.paypal.count('capture')).toBe(0);
  });
});

describe('the return is a trigger, never evidence', () => {
  it('P6: the stored provider id is used; another order PayPal id in play changes nothing', async () => {
    w = await makeWorld();
    const a = await approved(w);
    const b = await approved(w, { buyer_id: 'buy_B', actor: BUYER_B, offers: ['ofr_3'] });
    expect(a.provider_order_id).not.toBe(b.provider_order_id);
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('paid');
    for (const c of w.paypal.calls.filter((x) => x.op !== 'create')) {
      expect(c.provider_order_id).toBe(a.provider_order_id);
    }
    // Order B was neither read nor captured.
    expect(w.paypal.orders.get(b.provider_order_id)!.capture).toBeNull();
    expect((await order(b.order_id)).status).toBe('awaiting_buyer');
  });

  it("another buyer's order ref is not found, with no provider call", async () => {
    w = await makeWorld();
    const a = await approved(w);
    const before = w.paypal.calls.length;
    expect(await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_B })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await onBuyerReturn(w.deps, { order_ref: 'ord_NOSUCH', actor: BUYER_A })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(w.paypal.calls.length).toBe(before);
  });

  it('order not approved at PayPal: not_approved, no change, no capture', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    const r = await ret(a.order_ref);
    expect(r).toEqual({ ok: false, error: { code: 'not_approved' } });
    expect((await order(a.order_id)).status).toBe('awaiting_buyer');
    expect(w.paypal.count('capture')).toBe(0);
    expect(await op(a.order_id, 'capture')).toBeUndefined();
  });

  it('order still being created (no provider order yet): not_approved without a call', async () => {
    w = await makeWorld();
    const p = await place(w);
    expect(await ret(p.order_ref)).toEqual({ ok: false, error: { code: 'not_approved' } });
    expect(w.paypal.calls).toEqual([]);
  });

  it('checkout_enabled off: payments_paused, no provider call, nothing changes', async () => {
    w = await makeWorld();
    const a = await approved(w);
    const before = w.paypal.calls.length;
    w.switches.checkout_enabled = false;
    expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'payments_paused' } });
    expect(w.paypal.calls.length).toBe(before);
    expect((await order(a.order_id)).status).toBe('awaiting_buyer');
  });

  it('the pre-capture read blocked by the kill switch: payments_paused, no capture', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.get.push({ kind: 'blocked', by: 'kill_switch' });
    expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'payments_paused' } });
    expect(w.paypal.count('capture')).toBe(0);
  });

  it('the pre-capture read unavailable: not_approved, no change, buyer can return again', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.get.push({ kind: 'unavailable', retry_after_ms: null });
    expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'not_approved' } });
    expect(w.paypal.count('capture')).toBe(0);
    const second = await ret(a.order_ref);
    expect(second.ok && second.value.status).toBe('paid');
  });
});

describe('A-17: delivery readiness is checked before any charge', () => {
  it.each([
    ['object missing', (x: World) => x.content.heads.delete('key-art_1')],
    [
      'hash differs from the snapshot',
      (x: World) =>
        x.content.heads.set('key-art_1', {
          bytes: 3,
          sha256: sha256Of('other'),
          mime: 'text/plain',
        }),
    ],
    ['store unhealthy', (x: World) => (x.content.healthy = false)],
  ])('%s: no capture call, order failed, items declined, "not charged"', async (_n, break_) => {
    w = await makeWorld();
    const a = await approved(w);
    break_(w);
    const r = await ret(a.order_ref);
    expect(r).toEqual({ ok: false, error: { code: 'not_charged_content_unavailable' } });
    expect(w.paypal.count('capture')).toBe(0);
    expect((await order(a.order_id)).status).toBe('failed');
    expect((await unit(a.order_id)).status).toBe('declined');
    expect(await ent()).toMatchObject({ money_state: 'denied', access_state: 'locked' });
    expect(await op(a.order_id, 'capture')).toBeUndefined();
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(await count(w, 'alerts', "kind = 'content_unavailable'")).toBe(1);
    // Asked again: the same plain answer, and still no charge.
    expect(await ret(a.order_ref)).toEqual({
      ok: false,
      error: { code: 'not_charged_content_unavailable' },
    });
    expect(w.paypal.count('capture')).toBe(0);
  });

  it('the buyer message says "Not charged: content unavailable"', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.content.heads.delete('key-art_1');
    await ret(a.order_ref);
    const v = await loadOrderView(w.db, a.order_id);
    expect(v.buyer_message).toBe('Not charged: content unavailable');
    expect(v.status).toBe('failed');
  });

  it('one unreadable item among several stops the whole capture', async () => {
    w = await makeWorld();
    const a = await approved(w, { offers: ['ofr_1', 'ofr_3'] });
    w.content.heads.delete('key-art_3');
    expect(await ret(a.order_ref)).toEqual({
      ok: false,
      error: { code: 'not_charged_content_unavailable' },
    });
    expect(w.paypal.count('capture')).toBe(0);
  });
});

describe('switches', () => {
  it('unlock_enabled off books the capture but keeps access paused', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.switches.unlock_enabled = false;
    const r = await ret(a.order_ref);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('paid');
    expect(r.value.buyer_message).toBe('Access paused');
    expect(r.value.items[0]).toMatchObject({ access: 'locked' });
    expect(r.value.items[0]!.window.state).toBe('not_started');
    expect(await unit(a.order_id)).toMatchObject({ status: 'captured_verified' });
    expect(await ent()).toMatchObject({
      money_state: 'captured',
      access_state: 'locked',
      licence_state: 'granted',
    });
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    expect(await count(w, 'receipts')).toBe(1);
    expect(await count(w, 'access_events', "kind = 'access_ready'")).toBe(0);
  });

  it('after the switch returns, the next read unlocks and the window starts then, not before', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.switches.unlock_enabled = false;
    await ret(a.order_ref);
    w.clock.advance(3_600_000);
    w.switches.unlock_enabled = true;
    const report = await reapply(w, a.order_id);
    expect(report.unlocked).toHaveLength(1);
    const v = await loadOrderView(w.db, a.order_id);
    expect(v.items[0]).toMatchObject({ access: 'available' });
    expect(Date.parse(v.items[0]!.window.started_at!)).toBe(w.clock.now().getTime());
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    // Receipt v1 was issued at verification (access paused); v2 shows the window that started later.
    expect(await count(w, 'receipts')).toBe(2);
  });
});

describe('capture outcomes other than a clean claim', () => {
  it('timeout after sending: operation unknown, order unresolved, no read now, never a second call', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.next = { ...w.paypal.next, lose_response: true };
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('unresolved');
    expect(r.ok && r.value.items[0]!.access).toBe('locked');
    expect(w.paypal.calls.map((c) => c.op)).toEqual(['create', 'get', 'capture']);
    const cap = (await op(a.order_id, 'capture'))!;
    expect(cap.state).toBe('unknown');
    expect(cap.reconcile_until).not.toBeNull();
    expect(cap.next_retry_at).not.toBeNull();
    expect(await count(w, 'ledger_entries')).toBe(0);
    // Pressing return again does not capture again.
    await ret(a.order_ref);
    await ret(a.order_ref);
    expect(w.paypal.count('capture')).toBe(1);
  });

  it.each([
    ['unavailable', { kind: 'unavailable', retry_after_ms: null }],
    ['in_progress 409', { kind: 'in_progress', debug_id: null }],
    [
      '202 accepted',
      { kind: 'claim', http: 202, provider_order_id: 'X', units: [], debug_id: null },
    ],
    [
      'ORDER_ALREADY_CAPTURED',
      {
        kind: 'rejected',
        http: 422,
        name: 'UNPROCESSABLE_ENTITY',
        issue: 'ORDER_ALREADY_CAPTURED',
        debug_id: 'D',
      },
    ],
  ] as const)(
    '%s: unknown operation, unresolved order, no read now, locked',
    async (_n, forced) => {
      w = await makeWorld();
      const a = await approved(w);
      w.paypal.queue.capture.push(forced as never);
      const r = await ret(a.order_ref);
      expect(r.ok && r.value.status).toBe('unresolved');
      expect((await op(a.order_id, 'capture'))!.state).toBe('unknown');
      expect(w.paypal.count('get')).toBe(1);
      expect(await ent()).toMatchObject({ money_state: 'pending', access_state: 'locked' });
      expect(await count(w, 'ledger_entries')).toBe(0);
    },
  );

  it('payer_action: the order goes back to awaiting_buyer with the redirect link; the next try uses a new key (H2)', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push({
      kind: 'payer_action',
      redirect_url: 'https://www.sandbox.paypal.com/checkoutnow?token=AGAIN',
      debug_id: 'D',
    });
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('awaiting_buyer');
    expect(r.ok && r.value.approve_url).toBe(
      'https://www.sandbox.paypal.com/checkoutnow?token=AGAIN',
    );
    expect((await op(a.order_id, 'capture'))!.state).toBe('prepared');
    // The buyer fixes the funding source and returns. PayPal replays the stored answer for a key,
    // so the first key cannot succeed: a new attempt key is used, after a read (FIX-05A H2).
    const second = await ret(a.order_ref);
    expect(second.ok && second.value.status).toBe('paid');
    const keys = w.paypal.calls.filter((c) => c.op === 'capture').map((c) => c.request_id);
    expect(keys).toEqual([`umsK-${a.order_ref}`, `umsK-${a.order_ref}-2`]);
  });

  it('ORDER_NOT_APPROVED (a race): not_approved, back to awaiting_buyer, operation prepared', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push({
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'ORDER_NOT_APPROVED',
      debug_id: 'D',
    });
    expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'not_approved' } });
    expect((await order(a.order_id)).status).toBe('awaiting_buyer');
    expect((await op(a.order_id, 'capture'))!.state).toBe('prepared');
  });

  it('DUPLICATE_INVOICE_ID: the order is frozen and an alert is raised', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push({
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'DUPLICATE_INVOICE_ID',
      debug_id: 'D',
    });
    expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'frozen' } });
    expect((await order(a.order_id)).status).toBe('frozen');
    expect(await count(w, 'alerts', "kind = 'frozen_order'")).toBe(1);
    expect(w.paypal.count('capture')).toBe(1);
  });

  it('TRANSACTION_REFUSED: the read-back decides; with no capture shown the order closes as failed, not charged (M3)', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push({
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'TRANSACTION_REFUSED',
      debug_id: 'D',
    });
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('failed');
    expect((await unit(a.order_id)).status).toBe('declined');
    expect(await ent()).toMatchObject({ money_state: 'denied' });
    expect(w.paypal.count('get')).toBe(2);
  });

  it('TRANSACTION_REFUSED with a DECLINED capture on the read-back: declined only because the read shows it', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push({
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'TRANSACTION_REFUSED',
      debug_id: 'D',
    });
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === 2) {
        w.paypal.orders.get(a.provider_order_id)!.capture = {
          capture_id: 'SBXDEC1',
          status: 'DECLINED',
          reason: null,
          fee: null,
        };
      }
    };
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('failed');
    expect(await ent()).toMatchObject({ money_state: 'denied' });
  });
});

describe('crash after the capture (REL-2, REL-3)', () => {
  it('the process dies after PayPal captured: locked, never a second capture, one read-back unlocks exactly once', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.crashAfterCapture = true;
    await expect(ret(a.order_ref)).rejects.toThrow('process died');
    w.paypal.crashAfterCapture = false;

    // What the database knows after the crash: the capture was sent, nothing came back.
    expect((await order(a.order_id)).status).toBe('capture_requested');
    expect((await op(a.order_id, 'capture'))!.state).toBe('sent');
    expect(await unit(a.order_id)).toMatchObject({ status: 'expected', capture_id: null });
    expect(await ent()).toMatchObject({ money_state: 'pending', access_state: 'locked' });

    // Buyer presses return again, several times: no capture, no unlock.
    for (let i = 0; i < 5; i += 1) {
      const r = await ret(a.order_ref);
      expect(r.ok && r.value.items[0]!.access).toBe('locked');
    }
    expect(w.paypal.count('capture')).toBe(1);
    expect(await count(w, 'ledger_entries')).toBe(0);

    // The reconciler (lane 05b) reads the order: matching evidence unlocks, once.
    const first = await reapply(w, a.order_id);
    expect(first.unlocked).toHaveLength(1);
    expect(first.order_status).toBe('paid');
    const second = await reapply(w, a.order_id);
    expect(second.unlocked).toEqual([]);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    expect(await count(w, 'ledger_entries', "kind = 'paypal_fee'")).toBe(1);
    expect(await count(w, 'receipts')).toBe(1);
    expect(await count(w, 'access_events', "kind = 'access_ready'")).toBe(1);
    expect(w.paypal.count('capture')).toBe(1);
  });
});
