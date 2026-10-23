// BU-4 state tests: a refund is sent only for an amount PayPal itself still holds. Before the send,
// executeRefund reads the order (a read at most 60 s old is reused) and compares the stored request
// amount with PayPal's remaining amount: captured minus the refunds listed as COMPLETED or PENDING.
// Above it, the request is closed `failed` with reason over_refund_remote, its reservation is
// freed, `refund_unbooked` is raised for a human and nothing is sent. A read that is not available
// never lets a refund go: the request stays `requested` and the due-work pass tries again.
// Real PGlite, scripted PayPal that lists dashboard refunds. Synthetic rows only, no network.
import { afterEach, describe, expect, it } from 'vitest';
import { executeRefund, nextDueAt, requestRefund, runDue } from './index';
import { OPERATOR, alertKinds, ops, paid } from './ops/support';
import { makeRemainingWorld } from './remaining-world';
import type { RemainingWorld } from './remaining-world';

let w: RemainingWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const SEC = 1_000;
const usd = (minor: number) => ({ currency: 'USD', minor });

async function setup(price = 500) {
  w = await makeRemainingWorld({ price });
  const a = await paid(w);
  w.markReads();
  const unit = (
    await w.rows<{ id: string; capture_id: string; amount_minor: number }>(
      'SELECT id, capture_id, amount_minor FROM order_units WHERE order_id = $1',
      [a.order_id],
    )
  )[0]!;
  return { a, unit };
}
async function request(unit_id: string, minor: number | null): Promise<string> {
  const r = await requestRefund(w.deps, {
    unit_id,
    amount: minor === null ? null : usd(minor),
    reason: 'goodwill',
    actor: OPERATOR,
  });
  if (!r.ok) throw new Error(`refused: ${r.error.code}`);
  return r.value.refund_request_id;
}
const stateOf = async (id: string) =>
  (await w.rows<{ state: string }>('SELECT state FROM refund_requests WHERE id = $1', [id]))[0]!
    .state;
const reserved = async (unit_id: string) =>
  Number(
    (
      await w.rows<{ n: string }>(
        `SELECT COALESCE(sum(amount_minor), 0) AS n FROM refund_requests
          WHERE unit_id = $1 AND state IN ('requested', 'sent', 'unknown', 'pending', 'unresolved')`,
        [unit_id],
      )
    )[0]!.n,
  );
const alerts = (order_id: string) =>
  w.rows<{ kind: string; detail: { reason: string } & Record<string, unknown> }>(
    'SELECT kind, detail FROM alerts WHERE order_id = $1 ORDER BY kind, id',
    [order_id],
  );
const refundOps = async (order_id: string) =>
  (await ops(w, order_id)).filter((o) => o.kind === 'refund');
const unavailable = { kind: 'unavailable', retry_after_ms: null } as const;

describe('executeRefund and PayPal remaining amount', () => {
  it('dashboard refunded 3.00 of 5.00, operator asks for the rest: 2.00 is sent, not 5.00', async () => {
    const { a, unit } = await setup();
    w.dashboard(unit.capture_id, 300);
    const rq = await request(unit.id, 200); // the rest as the operator sees it: 5.00 - 3.00
    // The read must come before the send.
    const readsAtSend: number[] = [];
    const send = w.paypal.refundCapture.bind(w.paypal);
    w.paypal.refundCapture = (r) => {
      readsAtSend.push(w.reads());
      return send(r);
    };
    const r = await executeRefund(w.deps, { refund_request_id: rq });
    expect(r).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    expect(w.sends()).toHaveLength(1);
    expect(w.sends()[0]?.amount).toEqual(usd(200));
    expect(readsAtSend).toEqual([1]);
    expect(await stateOf(rq)).toBe('completed');
    expect(await alertKinds(w, a.order_id)).toEqual([]);
  });

  it('a request for "the rest" made before it was known stays at the local amount and is closed, not trimmed', async () => {
    // requestRefund fixes a null amount to the LOCAL remaining amount (5.00). PayPal holds 2.00.
    // The send path never sends a different amount than the stored one, so nothing is sent.
    const { a, unit } = await setup();
    w.dashboard(unit.capture_id, 300);
    const rq = await request(unit.id, null);
    expect(
      (
        await w.rows<{ amount_minor: number }>(
          'SELECT amount_minor FROM refund_requests WHERE id = $1',
          [rq],
        )
      )[0]!.amount_minor,
    ).toBe(500);
    const r = await executeRefund(w.deps, { refund_request_id: rq });
    expect(r).toEqual({ ok: true, value: { status: 'FAILED' } });
    expect(w.sends()).toHaveLength(0);
    expect(await stateOf(rq)).toBe('failed');
    expect(await alerts(a.order_id)).toHaveLength(1);
  });

  it('PayPal shows nothing left: no call, request failed over_refund_remote, reservation freed, one refund_unbooked alert', async () => {
    const { a, unit } = await setup();
    const rq = await request(unit.id, 200);
    expect(await reserved(unit.id)).toBe(200);
    w.dashboard(unit.capture_id, 500); // the dashboard refunded everything meanwhile
    const r = await executeRefund(w.deps, { refund_request_id: rq });
    expect(r).toEqual({ ok: true, value: { status: 'FAILED' } });
    expect(w.sends()).toHaveLength(0);
    expect(await stateOf(rq)).toBe('failed');
    expect(await reserved(unit.id)).toBe(0);
    const found = await alerts(a.order_id);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('refund_unbooked');
    expect(found[0]?.detail.reason).toBe(`over_refund_remote_${rq}`);
    expect(found[0]?.detail).toMatchObject({
      refund_request_id: rq,
      requested_minor: 200,
      remote_remaining_minor: 0,
    });
    expect(w.audits.filter((x) => x.action === 'refund.failed')).toEqual([
      expect.objectContaining({ target: rq, reason: 'over_refund_remote' }),
    ]);
    // Nothing was booked and no operation was left behind.
    expect(await refundOps(a.order_id)).toEqual([]);
    const u = (
      await w.rows<{ status: string; refunded_minor: number }>(
        'SELECT status, refunded_minor FROM order_units WHERE id = $1',
        [unit.id],
      )
    )[0]!;
    expect(u).toEqual({ status: 'captured_verified', refunded_minor: 0 });
    expect(await w.rows("SELECT 1 FROM ledger_entries WHERE kind = 'refund'")).toEqual([]);
    // The reservation is really free: the whole local amount can be requested again.
    expect(
      (
        await requestRefund(w.deps, {
          unit_id: unit.id,
          amount: usd(500),
          reason: 'x',
          actor: OPERATOR,
        })
      ).ok,
    ).toBe(true);
  });

  it('a second execute of a closed request raises nothing new and reads nothing', async () => {
    const { a, unit } = await setup();
    const rq = await request(unit.id, 200);
    w.dashboard(unit.capture_id, 500);
    await executeRefund(w.deps, { refund_request_id: rq });
    const reads = w.reads();
    expect(await executeRefund(w.deps, { refund_request_id: rq })).toEqual({
      ok: true,
      value: { status: 'FAILED' },
    });
    expect(w.reads()).toBe(reads);
    expect(await alerts(a.order_id)).toHaveLength(1);
  });

  it.each([
    ['unavailable', unavailable],
    ['timeout', { kind: 'timeout' }],
    ['not_found', { kind: 'not_found', debug_id: null }],
    ['in_progress', { kind: 'in_progress', debug_id: null }],
    ['blocked', { kind: 'blocked', by: 'kill_switch' }],
  ] as const)(
    'read %s: no call, request stays requested, next due time set',
    async (_name, read) => {
      const { a, unit } = await setup();
      const rq = await request(unit.id, 200);
      w.script(read as never);
      const r = await executeRefund(w.deps, { refund_request_id: rq });
      expect(r.ok).toBe(false);
      expect(w.sends()).toHaveLength(0);
      expect(await stateOf(rq)).toBe('requested');
      expect(await reserved(unit.id)).toBe(200); // still reserved: it can still be sent
      const found = await refundOps(a.order_id);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ kind: 'refund', state: 'unknown', attempt: 1 });
      const due = new Date(w.clock.now().getTime() + 30 * SEC);
      expect(found[0]?.next_retry_at?.toISOString()).toBe(due.toISOString());
      expect(await nextDueAt(w.db)).toBe(due.toISOString());
      expect(await alerts(a.order_id)).toEqual([]);
    },
  );

  it('a read that throws is not a send: the request stays requested with a due time', async () => {
    const { a, unit } = await setup();
    const rq = await request(unit.id, 200);
    w.paypal.beforeGet = () => Promise.reject(new Error('wire down'));
    const r = await executeRefund(w.deps, { refund_request_id: rq });
    w.paypal.beforeGet = null;
    expect(r.ok).toBe(false);
    expect(w.sends()).toHaveLength(0);
    expect(await stateOf(rq)).toBe('requested');
    expect(await refundOps(a.order_id)).toHaveLength(1);
  });

  it('read unavailable, then the due pass reads again and sends the stored amount once', async () => {
    const { a, unit } = await setup();
    const rq = await request(unit.id, 200);
    w.script(unavailable);
    await executeRefund(w.deps, { refund_request_id: rq });
    // Not yet due.
    expect(await runDue(w.deps, { max_items: 10 })).toMatchObject({ processed: 0 });
    expect(w.sends()).toHaveLength(0);
    w.tick(30 * SEC);
    const counts = await runDue(w.deps, { max_items: 10 });
    expect(counts.processed).toBe(1);
    expect(w.sends()).toHaveLength(1);
    expect(w.sends()[0]?.amount).toEqual(usd(200));
    expect(await stateOf(rq)).toBe('completed');
    const found = await refundOps(a.order_id);
    expect(found).toHaveLength(1);
    expect(found[0]?.state).toBe('confirmed');
    // A further pass sends nothing more.
    w.tick(10 * 60 * SEC);
    await runDue(w.deps, { max_items: 10 });
    expect(w.sends()).toHaveLength(1);
  });

  it('read unavailable twice in a row: still not sent, the next due time moves on', async () => {
    const { a, unit } = await setup();
    const rq = await request(unit.id, 200);
    w.script(unavailable, unavailable);
    await executeRefund(w.deps, { refund_request_id: rq });
    const first = (await refundOps(a.order_id))[0]!.next_retry_at!.getTime();
    w.tick(30 * SEC);
    await runDue(w.deps, { max_items: 10 });
    expect(w.sends()).toHaveLength(0);
    expect(await stateOf(rq)).toBe('requested');
    const op = (await refundOps(a.order_id))[0]!;
    expect(op.state).toBe('unknown');
    expect(op.next_retry_at!.getTime()).toBeGreaterThan(first);
    expect(op.next_retry_at!.getTime()).toBeGreaterThan(w.clock.now().getTime());
  });

  it('read unavailable, then PayPal shows nothing left: the due pass closes the request, no call', async () => {
    const { a, unit } = await setup();
    const rq = await request(unit.id, 200);
    w.script(unavailable);
    await executeRefund(w.deps, { refund_request_id: rq });
    w.dashboard(unit.capture_id, 500);
    w.tick(30 * SEC);
    await runDue(w.deps, { max_items: 10 });
    expect(w.sends()).toHaveLength(0);
    expect(await stateOf(rq)).toBe('failed');
    expect(await reserved(unit.id)).toBe(0);
    expect((await alerts(a.order_id)).map((x) => x.kind)).toEqual(['refund_unbooked']);
    const op = (await refundOps(a.order_id))[0]!;
    expect(op.state).toBe('failed');
    expect(op.next_retry_at).toBeNull();
  });

  it('read unavailable for the whole 24 h window: closed failed, reservation freed, a human told, never sent', async () => {
    const { a, unit } = await setup();
    const rq = await request(unit.id, 200);
    w.script(unavailable);
    await executeRefund(w.deps, { refund_request_id: rq });
    w.tick(24 * 3_600 * SEC + 1);
    w.script(unavailable);
    await runDue(w.deps, { max_items: 10 });
    expect(w.sends()).toHaveLength(0);
    expect(await stateOf(rq)).toBe('failed');
    expect(await reserved(unit.id)).toBe(0);
    const op = (await refundOps(a.order_id))[0]!;
    expect(op).toMatchObject({ state: 'failed', failure_reason: 'window_expired' });
    expect((await alerts(a.order_id)).map((x) => x.kind)).toEqual(['refund_failed']);
    expect(op.next_retry_at).toBeNull();
  });

  it('a pending dashboard refund counts against the remaining amount', async () => {
    const { unit } = await setup();
    w.dashboard(unit.capture_id, 300, 'PENDING');
    const big = await request(unit.id, 300);
    expect(await executeRefund(w.deps, { refund_request_id: big })).toEqual({
      ok: true,
      value: { status: 'FAILED' },
    });
    expect(w.sends()).toHaveLength(0);
    const ok = await request(unit.id, 200);
    expect((await executeRefund(w.deps, { refund_request_id: ok })).ok).toBe(true);
    expect(w.sends().map((s) => s.amount)).toEqual([usd(200)]);
  });

  it('failed and cancelled refunds do not count; completed and pending do', async () => {
    const { unit } = await setup();
    w.dashboard(unit.capture_id, 500, 'FAILED');
    w.dashboard(unit.capture_id, 500, 'CANCELLED');
    const rq = await request(unit.id, 500);
    const r = await executeRefund(w.deps, { refund_request_id: rq });
    expect(r.ok).toBe(true);
    expect(w.sends().map((s) => s.amount)).toEqual([usd(500)]);
  });

  it('the amount may equal what is left, and not one minor unit more', async () => {
    const { unit } = await setup();
    w.dashboard(unit.capture_id, 300);
    const exact = await request(unit.id, 200);
    expect((await executeRefund(w.deps, { refund_request_id: exact })).ok).toBe(true);
    expect(w.sends().map((s) => s.amount)).toEqual([usd(200)]);
  });
  it('one minor unit above what is left is not sent', async () => {
    const { unit } = await setup();
    w.dashboard(unit.capture_id, 300);
    const over = await request(unit.id, 201);
    expect(await executeRefund(w.deps, { refund_request_id: over })).toEqual({
      ok: true,
      value: { status: 'FAILED' },
    });
    expect(w.sends()).toHaveLength(0);
  });

  it('refunds made through UnitMarket count against the remaining amount too', async () => {
    const { unit } = await setup();
    const a1 = await request(unit.id, 300);
    expect((await executeRefund(w.deps, { refund_request_id: a1 })).ok).toBe(true);
    w.dashboard(unit.capture_id, 150);
    w.tick(61 * SEC); // a fresh read
    const b = await request(unit.id, 200); // local: 5.00 - 3.00 booked = 2.00; PayPal: 0.50
    expect(await executeRefund(w.deps, { refund_request_id: b })).toEqual({
      ok: true,
      value: { status: 'FAILED' },
    });
    expect(w.sends()).toHaveLength(1);
  });

  it('a capture PayPal shows smaller than ordered lowers the remaining amount', async () => {
    const { a, unit } = await setup();
    await w.editNextRead(a.provider_order_id, (r) => {
      r.units[0]!.capture!.amount = usd(400); // PayPal holds a 4.00 capture
      return r;
    });
    const rq = await request(unit.id, 500);
    expect(await executeRefund(w.deps, { refund_request_id: rq })).toEqual({
      ok: true,
      value: { status: 'FAILED' },
    });
    expect(w.sends()).toHaveLength(0);
  });

  it('a read that does not show the capture is not a basis for a send', async () => {
    const { a, unit } = await setup();
    const rq = await request(unit.id, 200);
    w.paypal.tamper.capture_id = 'SBXOTHERCAP';
    const r = await executeRefund(w.deps, { refund_request_id: rq });
    delete w.paypal.tamper.capture_id;
    expect(r.ok).toBe(false);
    expect(w.sends()).toHaveLength(0);
    expect(await stateOf(rq)).toBe('requested');
    expect(await refundOps(a.order_id)).toHaveLength(1);
  });

  it('a capture in another currency than the request is not a basis for a send', async () => {
    const { a, unit } = await setup();
    const rq = await request(unit.id, 200);
    await w.editNextRead(a.provider_order_id, (r) => {
      r.units[0]!.capture!.amount = { currency: 'EUR', minor: 500 };
      return r;
    });
    const r = await executeRefund(w.deps, { refund_request_id: rq });
    expect(r.ok).toBe(false);
    expect(w.sends()).toHaveLength(0);
    expect(await stateOf(rq)).toBe('requested');
  });

  it('refunds_enabled off: rejected before anything is read', async () => {
    const { unit } = await setup();
    const rq = await request(unit.id, 200);
    w.switches.refunds_enabled = false;
    expect(await executeRefund(w.deps, { refund_request_id: rq })).toEqual({
      ok: false,
      error: { code: 'rejected' },
    });
    expect(w.reads()).toBe(0);
    expect(w.sends()).toHaveLength(0);
    expect(await stateOf(rq)).toBe('requested');
  });

  it('an unknown request id, or a request already sent, reads nothing', async () => {
    const { unit } = await setup();
    expect(await executeRefund(w.deps, { refund_request_id: 'rfr_missing' })).toEqual({
      ok: false,
      error: { code: 'rejected' },
    });
    expect(w.reads()).toBe(0);
    const rq = await request(unit.id, 200);
    await executeRefund(w.deps, { refund_request_id: rq });
    const reads = w.reads();
    await executeRefund(w.deps, { refund_request_id: rq });
    expect(w.reads()).toBe(reads);
    expect(w.sends()).toHaveLength(1);
  });

  it('the amount sent is the stored request amount, also when the request asked for the rest', async () => {
    const { unit } = await setup();
    const odd = await request(unit.id, 123);
    await executeRefund(w.deps, { refund_request_id: odd });
    const rest = await request(unit.id, null); // local remaining after 1.23
    const stored = (
      await w.rows<{ amount_minor: number }>(
        'SELECT amount_minor FROM refund_requests WHERE id = $1',
        [rest],
      )
    )[0]!.amount_minor;
    expect(stored).toBe(377);
    w.tick(61 * SEC);
    await executeRefund(w.deps, { refund_request_id: rest });
    expect(w.sends().map((s) => s.amount)).toEqual([usd(123), usd(377)]);
  });

  describe('a read at most 60 s old is reused', () => {
    async function closedByFullDashboardRefund() {
      const { unit } = await setup();
      const dash = w.dashboard(unit.capture_id, 500);
      const r1 = await request(unit.id, 200);
      await executeRefund(w.deps, { refund_request_id: r1 });
      expect(w.reads()).toBe(1);
      // PayPal cancels the dashboard refund; only a new read can show it.
      w.refunds.get(dash)!.status = 'CANCELLED';
      return unit;
    }
    it('inside 60 s the first read still decides', async () => {
      const unit = await closedByFullDashboardRefund();
      w.tick(30 * SEC);
      const r2 = await request(unit.id, 200);
      expect(await executeRefund(w.deps, { refund_request_id: r2 })).toEqual({
        ok: true,
        value: { status: 'FAILED' },
      });
      expect(w.reads()).toBe(1);
      expect(w.sends()).toHaveLength(0);
    });
    it('a read exactly 60 s old is still reused', async () => {
      const unit = await closedByFullDashboardRefund();
      w.tick(60 * SEC);
      const r2 = await request(unit.id, 200);
      await executeRefund(w.deps, { refund_request_id: r2 });
      expect(w.reads()).toBe(1);
      expect(w.sends()).toHaveLength(0);
    });
    it('a read 60.001 s old is read again', async () => {
      const unit = await closedByFullDashboardRefund();
      w.tick(60 * SEC + 1);
      const r2 = await request(unit.id, 200);
      expect((await executeRefund(w.deps, { refund_request_id: r2 })).ok).toBe(true);
      expect(w.reads()).toBeGreaterThanOrEqual(2);
      expect(w.sends().map((s) => s.amount)).toEqual([usd(200)]);
    });
    it('a clock that moved backwards does not make an old read young', async () => {
      const unit = await closedByFullDashboardRefund();
      w.clock.advance(-10 * SEC);
      const r2 = await request(unit.id, 200);
      expect((await executeRefund(w.deps, { refund_request_id: r2 })).ok).toBe(true);
      expect(w.sends()).toHaveLength(1);
    });
    it('a refund sent by UnitMarket drops the read: the next request sees it', async () => {
      const { unit } = await setup();
      w.dashboard(unit.capture_id, 300); // PayPal holds 2.00
      const a1 = await request(unit.id, 100);
      expect((await executeRefund(w.deps, { refund_request_id: a1 })).ok).toBe(true);
      // Remaining at PayPal is now 1.00. A stale read would still say 2.00.
      w.tick(5 * SEC);
      const b = await request(unit.id, 200); // local remaining: 4.00
      expect(await executeRefund(w.deps, { refund_request_id: b })).toEqual({
        ok: true,
        value: { status: 'FAILED' },
      });
      expect(w.sends()).toHaveLength(1);
    });
    // Two paid orders, both fully refunded at the dashboard, so every request below is closed.
    async function twoClosedOrders() {
      const { unit } = await setup();
      const second = await paid(w, { buyer_id: 'buy_B' });
      w.markReads();
      const unit2 = (
        await w.rows<{ id: string; capture_id: string }>(
          'SELECT id, capture_id FROM order_units WHERE order_id = $1',
          [second.order_id],
        )
      )[0]!;
      w.dashboard(unit.capture_id, 500);
      w.dashboard(unit2.capture_id, 500);
      const closeOne = async (u: { id: string }) =>
        executeRefund(w.deps, { refund_request_id: await request(u.id, 200) });
      return { unit, unit2, closeOne };
    }
    it('a read taken a moment ago is reused, also for the same instant and with another order read between', async () => {
      const { unit, unit2, closeOne } = await twoClosedOrders();
      await closeOne(unit); // read of order 1
      await closeOne(unit2); // read of order 2, at the same instant
      expect(w.reads()).toBe(2);
      await closeOne(unit); // order 1 again, same instant: the first read is still there
      await closeOne(unit2);
      expect(w.reads()).toBe(2);
      expect(w.sends()).toHaveLength(0);
    });
    it('a read exactly 60 s old is still there when another order is read', async () => {
      const { unit, unit2, closeOne } = await twoClosedOrders();
      await closeOne(unit); // read of order 1
      w.tick(60 * SEC);
      await closeOne(unit2); // read of order 2; order 1 is exactly 60 s old
      expect(w.reads()).toBe(2);
      await closeOne(unit);
      expect(w.reads()).toBe(2);
    });
    it('a read older than 60 s is dropped when another order is read, and read again later', async () => {
      const { unit, unit2, closeOne } = await twoClosedOrders();
      await closeOne(unit);
      w.tick(60 * SEC + 1);
      await closeOne(unit2);
      await closeOne(unit);
      expect(w.reads()).toBe(3);
    });
    it('a read of another order is not reused', async () => {
      const { unit } = await setup();
      const second = await paid(w, { buyer_id: 'buy_B' });
      w.markReads();
      const unit2 = (
        await w.rows<{ id: string; capture_id: string }>(
          'SELECT id, capture_id FROM order_units WHERE order_id = $1',
          [second.order_id],
        )
      )[0]!;
      w.dashboard(unit2.capture_id, 500);
      const r1 = await request(unit.id, 200);
      await executeRefund(w.deps, { refund_request_id: r1 });
      const r2 = await request(unit2.id, 200);
      expect(await executeRefund(w.deps, { refund_request_id: r2 })).toEqual({
        ok: true,
        value: { status: 'FAILED' },
      });
      expect(w.sends().map((s) => s.capture_id)).toEqual([unit.capture_id]);
    });
  });
});

describe('which order is read, and the locks the check takes', () => {
  it('an order of two publishers: each unit is checked against its own capture', async () => {
    w = await makeRemainingWorld({ price: 400 });
    const a = await paid(w, { offers: ['ofr_1', 'ofr_3'] });
    w.markReads();
    const units = await w.rows<{ id: string; capture_id: string }>(
      'SELECT id, capture_id FROM order_units WHERE order_id = $1 ORDER BY reference_id',
      [a.order_id],
    );
    expect(units).toHaveLength(2);
    // The dashboard refunded the whole second unit and nothing of the first.
    w.dashboard(units[1]!.capture_id, 400);
    const first = await request(units[0]!.id, 400);
    expect((await executeRefund(w.deps, { refund_request_id: first })).ok).toBe(true);
    const second = await request(units[1]!.id, 400);
    expect(await executeRefund(w.deps, { refund_request_id: second })).toEqual({
      ok: true,
      value: { status: 'FAILED' },
    });
    expect(w.sends().map((x) => x.capture_id)).toEqual([units[0]!.capture_id]);
  });

  it('an order without a PayPal order id gives no read at all and a put-off send', async () => {
    const { a, unit } = await setup();
    await w.db.query('UPDATE provider_orders SET provider_order_id = NULL WHERE order_id = $1', [
      a.order_id,
    ]);
    const rq = await request(unit.id, 200);
    const r = await executeRefund(w.deps, { refund_request_id: rq });
    expect(r.ok).toBe(false);
    expect(w.reads()).toBe(0);
    expect(w.sends()).toHaveLength(0);
    expect(await stateOf(rq)).toBe('requested');
  });

  // The rows a transaction locks, in the order it locks them (FIX-PAY2 M-3): orders, operations,
  // order_units, refund_requests. A spy on the executor of every transaction records the statements.
  const RANK: [RegExp, number, string][] = [
    [/FROM orders\b.*FOR UPDATE/i, 1, 'orders'],
    [/FROM operations\b.*FOR UPDATE/i, 2, 'operations'],
    [/FROM order_units\b.*FOR UPDATE|FOR UPDATE OF u\b/i, 3, 'order_units'],
    [/FROM refund_requests\b.*FOR UPDATE/i, 4, 'refund_requests'],
  ];
  function spied(): { log: string[][] } {
    const log: string[][] = [];
    const d = w.deps;
    w.deps = {
      ...d,
      db: {
        ...d.db,
        transaction: (fn) => {
          const locks: string[] = [];
          log.push(locks);
          return d.db.transaction((tx) =>
            fn({
              query: (sql, params) => {
                const text = sql.replace(/\s+/g, ' ');
                const hit = RANK.find(([re]) => re.test(text));
                if (hit !== undefined) locks.push(hit[2]);
                return tx.query(sql, params);
              },
              exec: (sql) => tx.exec(sql),
            }),
          );
        },
      },
    };
    return { log };
  }
  const rank = (name: string) => RANK.find(([, , n]) => n === name)![1];
  // As in lockorder.state.test.ts: the first lock of a class is an event; a later statement on a
  // class that is already held takes no new lock.
  const inOrder = (locks: string[]) => {
    const held = new Set<number>();
    for (const name of locks) {
      const r = rank(name);
      if (held.has(r)) continue;
      if ([...held].some((h) => h > r)) return false;
      held.add(r);
    }
    return true;
  };

  it('closing an over-asking request locks order, operations, unit and request, in that order', async () => {
    const { unit } = await setup();
    const rq = await request(unit.id, 200);
    w.dashboard(unit.capture_id, 500);
    const { log } = spied();
    await executeRefund(w.deps, { refund_request_id: rq });
    const closing = log[0]; // the first transaction closes the request
    expect(closing).toBeDefined();
    expect(closing!.slice(0, 4)).toEqual([
      'orders',
      'operations',
      'order_units',
      'refund_requests',
    ]);
    expect(closing!.includes('operations')).toBe(true);
    expect(inOrder(closing!)).toBe(true);
    for (const l of log) expect(inOrder(l)).toBe(true);
  });

  it('putting a send off locks order, operations, unit and request, in that order', async () => {
    const { unit } = await setup();
    const rq = await request(unit.id, 200);
    w.script(unavailable);
    const { log } = spied();
    await executeRefund(w.deps, { refund_request_id: rq });
    const putOff = log[0]; // the first transaction puts the send off
    expect(putOff).toBeDefined();
    expect(putOff!.slice(0, 4)).toEqual(['orders', 'operations', 'order_units', 'refund_requests']);
    expect(putOff!.includes('operations')).toBe(true);
    for (const l of log) expect(inOrder(l)).toBe(true);
  });

  it('the first send locks order, operations, unit and request, in that order', async () => {
    const { unit } = await setup();
    const rq = await request(unit.id, 200);
    const { log } = spied();
    await executeRefund(w.deps, { refund_request_id: rq });
    const preparing = log[0]; // the first transaction of executeRefund prepares the send
    expect(preparing).toEqual(['orders', 'operations', 'order_units', 'refund_requests']);
    for (const l of log) expect(inOrder(l)).toBe(true);
    // The statement that takes the request row must be the locking one.
    expect(w.sends()).toHaveLength(1);
  });

  it('closing a request whose window ended locks the order first, then the operations', async () => {
    const { unit } = await setup();
    const rq = await request(unit.id, 200);
    w.script(unavailable);
    await executeRefund(w.deps, { refund_request_id: rq });
    w.tick(24 * 3_600 * SEC + 1);
    w.script(unavailable);
    const { log } = spied();
    await runDue(w.deps, { max_items: 10 });
    expect(await stateOf(rq)).toBe('failed');
    expect(log.some((l) => l.includes('operations'))).toBe(true);
    for (const l of log) expect(inOrder(l)).toBe(true);
  });
});
