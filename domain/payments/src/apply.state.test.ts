// State tests of applyReadback driven with crafted reads (the way the reconciler of lane 05b and the
// webhook handler will call it): one verified unlock, never twice, never from a claim, never on a
// mismatch. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import type { Id, OrderRead } from '@umsbx/contracts';
import { applyReadback, loadOrderView, onBuyerReturn, readApplyGates } from './index';
import type { ApplyGates } from './index';
import {
  BUYER_A,
  FIVE_DAYS_MS,
  approved,
  count,
  makeWorld,
  reapply,
  sha256ForArticle,
} from './support';
import type { Awaiting, World } from './support';

type Read = Extract<OrderRead, { kind: 'order' }>;
let w: World;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

/** An order whose capture was sent and whose answer never came back. */
async function sentCapture(o: Parameters<typeof approved>[1] = {}): Promise<Awaiting> {
  const a = await approved(w, o);
  w.paypal.crashAfterCapture = true;
  await expect(onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A })).rejects.toThrow();
  w.paypal.crashAfterCapture = false;
  return a;
}
const readOf = async (a: Awaiting): Promise<Read> => {
  const r = await w.paypal.getOrder(a.provider_order_id);
  if (r.kind !== 'order') throw new Error('no read');
  return r;
};
const withUnit = (
  r: Read,
  i: number,
  f: (u: Read['units'][number]) => Read['units'][number],
): Read => ({
  ...r,
  units: r.units.map((u, k) => (k === i ? f(u) : u)),
});
const setCapture = (
  r: Read,
  i: number,
  c: {
    id: string;
    status: 'COMPLETED' | 'PENDING' | 'DECLINED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
    reason?: string | null;
    fee?: number | null;
  } | null,
): Read =>
  withUnit(r, i, (u) => ({
    ...u,
    capture:
      c === null
        ? null
        : {
            capture_id: c.id,
            status: c.status,
            status_reason: c.reason ?? null,
            paypal_fee_minor: c.fee === undefined ? 45 : c.fee,
            refunded_minor: 0,
          },
  }));
const gatesOf = async (id: Id): Promise<ApplyGates> => readApplyGates(w.deps, id);
const apply = async (
  id: Id,
  read: Read,
  gates?: ApplyGates | null,
  trigger: 'poll' | 'webhook' | 'return' | 'capture' = 'poll',
) => {
  const g = gates === undefined ? await gatesOf(id) : gates;
  return w.db.transaction((tx) =>
    applyReadback(tx, w.deps, { order_id: id, read, trigger, ...(g === null ? {} : { gates: g }) }),
  );
};
const unit = async (order_id: string, n = 0) =>
  (
    await w.rows<Record<string, unknown>>(
      'SELECT * FROM order_units WHERE order_id = $1 ORDER BY publisher_id',
      [order_id],
    )
  )[n]!;
const ents = async () =>
  w.rows<Record<string, unknown>>('SELECT * FROM entitlements ORDER BY article_id');
const status = async (id: string) =>
  (
    await w.rows<{ status: string; mismatch: boolean }>(
      'SELECT status, mismatch FROM orders WHERE id = $1',
      [id],
    )
  )[0]!;

describe('a matching read unlocks once', () => {
  it('COMPLETED: verified, unlocked, booked, receipted; the report names what happened', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const report = await reapply(w, a.order_id);
    expect(report.order_status).toBe('paid');
    expect(report.unlocked).toHaveLength(1);
    expect(report.pending).toEqual([]);
    expect(report.declined).toEqual([]);
    expect(report.mismatched).toEqual([]);
    expect(report.alerts).toEqual([]);
    expect(await ents()).toMatchObject([{ money_state: 'captured', access_state: 'available' }]);
  });

  it('a second identical read changes nothing: one sale, one fee, one receipt, window start stays', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    await reapply(w, a.order_id);
    const started = (await loadOrderView(w.db, a.order_id)).items[0]!.window.started_at;
    w.clock.advance(7_200_000);
    const again = await reapply(w, a.order_id);
    expect(again.unlocked).toEqual([]);
    expect(again.order_status).toBe('paid');
    expect(await count(w, 'ledger_entries')).toBe(2);
    expect(await count(w, 'receipts')).toBe(1);
    expect((await loadOrderView(w.db, a.order_id)).items[0]!.window.started_at).toBe(started);
  });

  it('the window ends five days after the moment of verification', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    w.clock.advance(600_000);
    await reapply(w, a.order_id);
    const v = await loadOrderView(w.db, a.order_id);
    expect(
      Date.parse(v.items[0]!.window.ends_at!) - Date.parse(v.items[0]!.window.started_at!),
    ).toBe(FIVE_DAYS_MS);
    expect(Date.parse(v.items[0]!.window.started_at!)).toBe(w.clock.now().getTime());
  });

  it('no fee observed: the sale is booked and no fee row exists', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const r = setCapture(await readOf(a), 0, { id: 'CAPNOFEE', status: 'COMPLETED', fee: null });
    await apply(a.order_id, r);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    expect(await count(w, 'ledger_entries', "kind = 'paypal_fee'")).toBe(0);
    expect((await unit(a.order_id)).paypal_fee_minor).toBeNull();
  });

  it('a fee above the amount is booked as observed and raises an alert', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const r = setCapture(await readOf(a), 0, { id: 'CAPBIGFEE', status: 'COMPLETED', fee: 401 });
    const report = await apply(a.order_id, r);
    expect(report.alerts).toContain('fee_above_amount');
    expect(await count(w, 'ledger_entries', "kind = 'paypal_fee'")).toBe(1);
  });

  it('PARTIALLY_REFUNDED as the first sight of a capture is still a verified sale of the full amount', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const r = setCapture(await readOf(a), 0, { id: 'CAPPR', status: 'PARTIALLY_REFUNDED' });
    const report = await apply(a.order_id, r);
    expect(report.unlocked).toHaveLength(1);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });

  it('the observed fee stays out of the match: a different fee never blocks', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const r = setCapture(await readOf(a), 0, { id: 'CAPF', status: 'COMPLETED', fee: 0 });
    expect((await apply(a.order_id, r)).unlocked).toHaveLength(1);
  });
});

describe('pending, declined, mismatch', () => {
  it('PENDING keeps the reason, stays locked, then COMPLETED later unlocks', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const base = await readOf(a);
    const pend = await apply(
      a.order_id,
      setCapture(base, 0, { id: 'CAPP', status: 'PENDING', reason: 'ECHECK' }),
    );
    expect(pend.order_status).toBe('unresolved');
    expect(pend.pending).toHaveLength(1);
    expect(pend.unlocked).toEqual([]);
    expect(await unit(a.order_id)).toMatchObject({
      status: 'pending',
      status_reason: 'ECHECK',
      capture_id: 'CAPP',
    });
    expect(await ents()).toMatchObject([{ money_state: 'pending', access_state: 'locked' }]);
    const view = await loadOrderView(w.db, a.order_id);
    expect(view.buyer_message).toContain('ECHECK');

    w.clock.advance(120_000);
    const done = await apply(a.order_id, setCapture(base, 0, { id: 'CAPP', status: 'COMPLETED' }));
    expect(done.unlocked).toHaveLength(1);
    expect(done.order_status).toBe('paid');
    expect(await unit(a.order_id)).toMatchObject({
      status: 'captured_verified',
      status_reason: null,
    });
  });

  it('PENDING read twice stays pending, with one unit row change at most and no booking', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const r = setCapture(await readOf(a), 0, { id: 'CAPP', status: 'PENDING', reason: 'X' });
    await apply(a.order_id, r);
    const again = await apply(a.order_id, r);
    expect(again.order_status).toBe('unresolved');
    expect(await count(w, 'ledger_entries')).toBe(0);
  });

  it.each(['DECLINED', 'FAILED'] as const)(
    '%s: unit declined, items denied, order failed, no sale',
    async (st) => {
      w = await makeWorld();
      const a = await sentCapture();
      const report = await apply(
        a.order_id,
        setCapture(await readOf(a), 0, { id: 'CAPD', status: st, fee: null }),
      );
      expect(report.declined).toHaveLength(1);
      expect(report.order_status).toBe('failed');
      expect(await ents()).toMatchObject([{ money_state: 'denied', access_state: 'locked' }]);
      expect(await count(w, 'ledger_entries')).toBe(0);
    },
  );

  it('a unit that was declined never turns into a sale on a later COMPLETED read', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const base = await readOf(a);
    await apply(a.order_id, setCapture(base, 0, { id: 'CAPD', status: 'DECLINED', fee: null }));
    const later = await apply(a.order_id, setCapture(base, 0, { id: 'CAPD', status: 'COMPLETED' }));
    expect(later.unlocked).toEqual([]);
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(await ents()).toMatchObject([{ money_state: 'denied' }]);
  });

  it('no capture on the read: the order stays unresolved and nothing changes', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const report = await apply(a.order_id, setCapture(await readOf(a), 0, null));
    expect(report.order_status).toBe('unresolved');
    expect(report.unlocked).toEqual([]);
  });

  it('REFUNDED as the first sight is a mismatch alert, never an unlock', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const report = await apply(
      a.order_id,
      setCapture(await readOf(a), 0, { id: 'CAPR', status: 'REFUNDED' }),
    );
    expect(report.mismatched).toHaveLength(1);
    expect(report.unlocked).toEqual([]);
    expect(report.order_status).toBe('frozen');
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(await ents()).toMatchObject([{ money_state: 'pending', access_state: 'locked' }]);
    expect(await count(w, 'alerts', "kind = 'frozen_order'")).toBe(1);
  });

  it('the order-level alert is raised once per reason, however often the same bad read comes', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const bad: Read = { ...(await readOf(a)), custom_id: 'ord_ELSE' };
    await apply(a.order_id, bad);
    await apply(a.order_id, bad);
    await apply(a.order_id, bad);
    expect(await count(w, 'alerts', "kind = 'frozen_order'")).toBe(1);
    expect((await status(a.order_id)).status).toBe('frozen');
  });

  it('a frozen order is not unlocked by a later clean read: a human decides', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const base = await readOf(a);
    await apply(a.order_id, { ...base, custom_id: 'ord_ELSE' });
    const clean = await apply(a.order_id, base);
    expect(clean.unlocked).toEqual([]);
    expect((await status(a.order_id)).status).toBe('frozen');
    expect(await count(w, 'ledger_entries')).toBe(0);
  });

  it('a bad read of a paid order keeps it paid, flags it and leaves access as it was', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const base = await readOf(a);
    await apply(a.order_id, base);
    const bad = await apply(a.order_id, { ...base, custom_id: 'ord_ELSE' });
    expect(bad.order_status).toBe('paid');
    expect(await status(a.order_id)).toMatchObject({ status: 'paid', mismatch: true });
    expect(await ents()).toMatchObject([{ access_state: 'available' }]);
    expect(await count(w, 'alerts', "kind = 'frozen_order'")).toBe(1);
  });

  it('a matching capture on a failed order is not unlocked; it raises an alert for a human', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    await w.db.query("UPDATE orders SET status = 'failed' WHERE id = $1", [a.order_id]);
    const report = await apply(a.order_id, await readOf(a));
    expect(report.unlocked).toEqual([]);
    expect(report.alerts).toContain('unexpected_capture');
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(await ents()).toMatchObject([{ money_state: 'pending', access_state: 'locked' }]);
  });
});

describe('gates: unlock switch and delivery readiness', () => {
  it('without gates nothing starts: the capture is booked, access stays locked (fail closed)', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const report = await apply(a.order_id, await readOf(a), null);
    expect(report.unlocked).toEqual([]);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    expect(await ents()).toMatchObject([{ money_state: 'captured', access_state: 'locked' }]);
    // The next read with the gates unlocks.
    const later = await apply(a.order_id, await readOf(a));
    expect(later.unlocked).toHaveLength(1);
  });

  it('unlock_enabled off books and verifies but starts no window', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    w.switches.unlock_enabled = false;
    const report = await apply(a.order_id, await readOf(a));
    expect(report.unlocked).toEqual([]);
    expect(report.order_status).toBe('paid');
    expect(await count(w, 'access_events')).toBe(0);
  });

  it('delivery not ready after the capture: money verified and booked, item locked, alert raised', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    w.content.heads.delete('key-art_1');
    const report = await apply(a.order_id, await readOf(a));
    expect(report.unlocked).toEqual([]);
    expect(report.alerts).toContain('content_unavailable');
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    expect(await ents()).toMatchObject([{ money_state: 'captured', access_state: 'locked' }]);
    // Content is restored: the next read starts the clock.
    w.content.heads.set('key-art_1', {
      bytes: 10,
      sha256: sha256ForArticle('art_1'),
      mime: 'text/plain',
    });
    const fixed = await apply(a.order_id, await readOf(a));
    expect(fixed.unlocked).toHaveLength(1);
  });
});

describe('several publishers in one order', () => {
  it('one unit matched, the other pending: the first unlocks, the order stays unresolved', async () => {
    w = await makeWorld();
    const a = await sentCapture({ offers: ['ofr_1', 'ofr_3'] });
    const base = await readOf(a);
    // Units are in publisher order: pub_1 then pub_2.
    let r = setCapture(base, 0, { id: 'CAP1', status: 'COMPLETED' });
    r = setCapture(r, 1, { id: 'CAP2', status: 'PENDING', reason: 'ECHECK' });
    const report = await apply(a.order_id, r);
    expect(report.unlocked).toHaveLength(1);
    expect(report.pending).toHaveLength(1);
    expect(report.order_status).toBe('unresolved');
    const access = (await ents()).map((e) => e.access_state);
    expect(access).toEqual(['available', 'locked']);

    const done = await apply(a.order_id, setCapture(r, 1, { id: 'CAP2', status: 'COMPLETED' }));
    expect(done.order_status).toBe('paid');
    expect(done.unlocked).toHaveLength(1);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(2);
    expect(await count(w, 'receipts')).toBe(2);
  });

  it('one unit matched, the other declined: paid_partial', async () => {
    w = await makeWorld();
    const a = await sentCapture({ offers: ['ofr_1', 'ofr_3'] });
    let r = setCapture(await readOf(a), 0, { id: 'CAP1', status: 'COMPLETED' });
    r = setCapture(r, 1, { id: 'CAP2', status: 'DECLINED', fee: null });
    const report = await apply(a.order_id, r);
    expect(report.order_status).toBe('paid_partial');
    expect((await ents()).map((e) => e.access_state)).toEqual(['available', 'locked']);
  });

  it('one unit matched, the other mismatched: nothing unlocks from that read and the order freezes', async () => {
    w = await makeWorld();
    const a = await sentCapture({ offers: ['ofr_1', 'ofr_3'] });
    let r = setCapture(await readOf(a), 0, { id: 'CAP1', status: 'COMPLETED' });
    r = setCapture(r, 1, { id: 'CAP2', status: 'COMPLETED' });
    r = withUnit(r, 1, (u) => ({ ...u, amount: { ...u.amount, minor: u.amount.minor + 1 } }));
    const report = await apply(a.order_id, r);
    expect(report.unlocked).toEqual([]);
    expect(report.mismatched).toHaveLength(1);
    expect(report.order_status).toBe('frozen');
    expect(await count(w, 'ledger_entries')).toBe(0);
  });
});
