// Test world for lane 05b: lane 05a's world plus a scripted refund side at PayPal, dashboard refunds,
// forced capture statuses, a "process dies" switch before the capture reaches PayPal, and a spy that
// reports any refund call made inside a database transaction. Synthetic rows only, no network.
import type {
  CaptureStatus,
  Id,
  Money,
  PaymentsDeps,
  RefundRes,
  RefundStatus,
} from '@umsbx/contracts';
import { onBuyerReturn } from '../index';
import { approved, makeWorld as makeBaseWorld } from '../support';
import type { Awaiting, World, WorldOptions } from '../support';

export {
  BUYER_A,
  BUYER_B,
  START,
  approvePo,
  approved,
  awaiting,
  collapseToD1Dormant,
  count,
  place,
  providerOrdersOf,
  setOrderStatus,
} from '../support';
export type { Awaiting, ProviderOrderInfo, World } from '../support';

export interface FakeRefund {
  refund_id: string;
  capture_id: string;
  request_id: string | null;
  amount: Money;
  status: RefundStatus;
}
export interface OpsWorld extends World {
  refunds: Map<string, FakeRefund>;
  refundCalls: { request_id: string; capture_id: string; amount: Money | null }[];
  getRefundCalls: string[];
  /** What the next refund call does at PayPal. */
  refundNext: {
    status: RefundStatus;
    /** The refund happens, the answer is lost. */
    lose_response: boolean;
    /** PayPal refuses the refund. */
    reject: boolean;
    /** GET refund answers with this status instead of the stored one (read-back differs). */
    read_status: RefundStatus | null;
    /** GET refund answers with this amount instead (minor units). */
    read_minor: number | null;
  };
  /**
   * What the order read reports as the refunded total of a capture. Real PayPal may report 0 for a
   * refunded capture (map-order.ts: the field is advisory), so the default is false: the read
   * shows the capture STATUS (PARTIALLY_REFUNDED, REFUNDED) and refunded_minor 0. A test that
   * needs the old behaviour sets it to true.
   */
  reportRefunded: boolean;
  /** Faults of the process. */
  faults: { dieBeforeCapture: boolean; loseCreateResponse: boolean };
  /** A refund made at the PayPal dashboard: money went back, UnitMarket never heard of it. */
  dashboardRefund(capture_id: string, minor: number): void;
  /** Forces the status of a capture in every order read. */
  forceStatus(capture_id: string, status: CaptureStatus | null): void;
  /** The capture ids of an order, by unit reference order. */
  captureIds(order_id: Id): Promise<string[]>;
  /** Moves the clock and returns the new time. */
  tick(ms: number): string;
  /** A second process on the same database and the same scripted PayPal (a restart). */
  restart(): PaymentsDeps;
}

export async function makeWorld(opts: WorldOptions = {}): Promise<OpsWorld> {
  const base = await makeBaseWorld(opts);
  const db = base.db;
  const paypal = base.paypal;
  const refunds = new Map<string, FakeRefund>();
  const forced = new Map<string, CaptureStatus>();
  const refundCalls: OpsWorld['refundCalls'] = [];
  const getRefundCalls: string[] = [];
  const refundNext: OpsWorld['refundNext'] = {
    status: 'COMPLETED',
    lose_response: false,
    reject: false,
    read_status: null,
    read_minor: null,
  };
  const faults = { dieBeforeCapture: false, loseCreateResponse: false };
  const flags = { reportRefunded: false };
  let n = 0;
  // The spy of lane 05a's fake knows when a call is made inside a database transaction. Its own
  // read is used as the probe (and not kept in the call log), so the refund calls are held to the
  // same rule without a second tracker.
  const probe = paypal.getOrder.bind(paypal);
  const guard = async (): Promise<void> => {
    const kept = paypal.calls.length;
    const queued = paypal.queue.get.splice(0); // the probe must not use up a scripted read
    const hook = paypal.beforeGet;
    paypal.beforeGet = null;
    try {
      await probe('SBXPROBE');
    } finally {
      paypal.calls.length = kept;
      paypal.queue.get.unshift(...queued);
      paypal.beforeGet = hook;
    }
  };

  // The capture as the order read shows it: refunds and forced statuses applied.
  const realGet = probe;
  paypal.getOrder = async (id, scenario) => {
    const r = await realGet(id, scenario);
    if (r.kind !== 'order') return r;
    return {
      ...r,
      units: r.units.map((u) => {
        const c = u.capture;
        if (c === null) return u;
        const done = [...refunds.values()]
          .filter((x) => x.capture_id === c.capture_id && x.status === 'COMPLETED')
          .reduce((s, x) => s + x.amount.minor, 0);
        const status: CaptureStatus =
          forced.get(c.capture_id) ??
          (done === 0
            ? c.status
            : done >= u.amount.minor
              ? 'REFUNDED'
              : ('PARTIALLY_REFUNDED' as CaptureStatus));
        return {
          ...u,
          capture: {
            ...c,
            status,
            refunded_minor: flags.reportRefunded ? done : 0,
            amount: u.amount,
          } as typeof c,
        };
      }),
    };
  };

  const realCreate = paypal.createOrder.bind(paypal);
  paypal.createOrder = async (r) => {
    const res = await realCreate(r);
    return faults.loseCreateResponse ? { kind: 'timeout' } : res;
  };

  const realCapture = paypal.captureOrder.bind(paypal);
  paypal.captureOrder = (r) => {
    if (faults.dieBeforeCapture) {
      paypal.calls.push({
        op: 'capture',
        provider_order_id: r.provider_order_id,
        request_id: r.request_id,
        scenario: null,
      });
      return Promise.reject(new Error('process died before the capture reached PayPal'));
    }
    return realCapture(r);
  };

  paypal.refundCapture = async (r) => {
    await guard();
    refundCalls.push({ request_id: r.request_id, capture_id: r.capture_id, amount: r.amount });
    const same = [...refunds.values()].find((x) => x.request_id === r.request_id);
    if (same !== undefined) return Promise.resolve(refundRes(same));
    if (refundNext.reject) {
      return Promise.resolve<RefundRes>({
        kind: 'rejected',
        http: 422,
        name: 'UNPROCESSABLE_ENTITY',
        issue: 'CAPTURE_FULLY_REFUNDED',
        debug_id: 'DBGREF',
      });
    }
    n += 1;
    const amount: Money = r.amount ?? { currency: 'USD', minor: remainingOf(r.capture_id) };
    const refund: FakeRefund = {
      refund_id: `SBXFAKEREF${String(n).padStart(5, '0')}`,
      capture_id: r.capture_id,
      request_id: r.request_id,
      amount,
      status: refundNext.status,
    };
    refunds.set(refund.refund_id, refund);
    if (refundNext.lose_response) return Promise.resolve<RefundRes>({ kind: 'timeout' });
    return Promise.resolve(refundRes(refund));
  };
  paypal.getRefund = async (id) => {
    await guard();
    getRefundCalls.push(id);
    const r = refunds.get(id);
    if (r === undefined) return Promise.resolve<RefundRes>({ kind: 'not_found', debug_id: null });
    return Promise.resolve(
      refundRes({
        ...r,
        status: refundNext.read_status ?? r.status,
        amount:
          refundNext.read_minor === null
            ? r.amount
            : { currency: r.amount.currency, minor: refundNext.read_minor },
      }),
    );
  };
  function refundRes(r: FakeRefund): RefundRes {
    return {
      kind: 'refund',
      refund_id: r.refund_id,
      status: r.status,
      amount: r.amount,
      capture_id: r.capture_id,
      debug_id: 'DBGREF',
    };
  }
  function remainingOf(capture_id: string): number {
    for (const o of paypal.orders.values()) {
      const k = o.req.units.findIndex((_, i) => captureIdAt(o, i) === capture_id);
      if (k >= 0) {
        const paid = [...refunds.values()]
          .filter((x) => x.capture_id === capture_id && x.status !== 'FAILED')
          .reduce((s, x) => s + x.amount.minor, 0);
        return (o.req.units[k]?.amount.minor ?? 0) - paid;
      }
    }
    return 0;
  }
  const captureIdAt = (o: { capture: { capture_id: string } | null }, k: number): string =>
    `${o.capture?.capture_id ?? ''}${k === 0 ? '' : `U${k}`}`;

  const deps: PaymentsDeps = { ...base.deps, db };
  const world: OpsWorld = {
    ...base,
    deps,
    db,
    refunds,
    refundCalls,
    getRefundCalls,
    refundNext,
    faults,
    get reportRefunded() {
      return flags.reportRefunded;
    },
    set reportRefunded(v: boolean) {
      flags.reportRefunded = v;
    },
    dashboardRefund(capture_id, minor) {
      n += 1;
      refunds.set(`SBXDASH${String(n).padStart(5, '0')}`, {
        refund_id: `SBXDASH${String(n).padStart(5, '0')}`,
        capture_id,
        request_id: null,
        amount: { currency: 'USD', minor },
        status: 'COMPLETED',
      });
    },
    forceStatus(capture_id, status) {
      if (status === null) forced.delete(capture_id);
      else forced.set(capture_id, status);
    },
    async captureIds(order_id) {
      const rows = await base.rows<{ capture_id: string | null }>(
        'SELECT capture_id FROM order_units WHERE order_id = $1 ORDER BY reference_id',
        [order_id],
      );
      return rows.map((r) => r.capture_id ?? '');
    },
    tick(ms) {
      base.clock.advance(ms);
      return base.clock.now().toISOString();
    },
    restart() {
      // A new process: new dependency object, same database, same PayPal. In-memory state is gone.
      return { ...deps };
    },
  };
  return world;
}

// ---------- journeys ----------
const buyerOf = (o: { buyer_id?: string }) => ({
  kind: 'buyer' as const,
  buyer_id: o.buyer_id ?? 'buy_A',
});
/** Approved at PayPal; the capture happens but the answer is lost (the process dies). */
export async function sentCapture(
  w: OpsWorld,
  o: Parameters<typeof approved>[1] = {},
): Promise<Awaiting> {
  const a = await approved(w, o);
  w.paypal.crashAfterCapture = true;
  await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: buyerOf(o) }).then(
    () => {
      throw new Error('the capture should have died');
    },
    () => undefined,
  );
  w.paypal.crashAfterCapture = false;
  return a;
}
/** Approved; the capture call dies before PayPal sees it. */
export async function deadCapture(
  w: OpsWorld,
  o: Parameters<typeof approved>[1] = {},
): Promise<Awaiting> {
  const a = await approved(w, o);
  w.faults.dieBeforeCapture = true;
  await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: buyerOf(o) }).then(
    () => {
      throw new Error('the capture should have died');
    },
    () => undefined,
  );
  w.faults.dieBeforeCapture = false;
  return a;
}
/** Approved; PayPal captured, the response timed out (the process lives). */
export async function lostResponse(
  w: OpsWorld,
  o: Parameters<typeof approved>[1] = {},
): Promise<Awaiting> {
  const a = await approved(w, o);
  w.paypal.next.lose_response = true;
  const r = await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: buyerOf(o) });
  w.paypal.next.lose_response = false;
  if (!r.ok) throw new Error(`return refused: ${r.error.code}`);
  return a;
}
/** Paid and unlocked. */
export async function paid(w: OpsWorld, o: Parameters<typeof approved>[1] = {}): Promise<Awaiting> {
  const a = await approved(w, o);
  const r = await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: buyerOf(o) });
  if (!r.ok || r.value.status !== 'paid') throw new Error('order is not paid');
  return a;
}

export const OPERATOR = { kind: 'operator', operator_id: 'opr_1', mfa: true } as const;

export async function orderStatus(w: OpsWorld, order_id: Id): Promise<string> {
  return (
    await w.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [order_id])
  )[0]!.status;
}
export async function ops(
  w: OpsWorld,
  order_id: Id,
): Promise<
  {
    id: string;
    kind: string;
    state: string;
    attempt: number;
    failure_reason: string | null;
    next_retry_at: Date | null;
    request_id: string;
  }[]
> {
  return w.rows(
    'SELECT id, kind, state, attempt, failure_reason, next_retry_at, request_id FROM operations WHERE order_id = $1 ORDER BY created_at, id',
    [order_id],
  );
}
export async function opOf(
  w: OpsWorld,
  order_id: Id,
  kind: string,
): Promise<Awaited<ReturnType<typeof ops>>[number]> {
  const found = (await ops(w, order_id)).filter((o) => o.kind === kind);
  if (found.length !== 1) throw new Error(`expected one ${kind} operation, found ${found.length}`);
  return found[0]!;
}
export async function alertKinds(w: OpsWorld, order_id: Id): Promise<string[]> {
  return (
    await w.rows<{ kind: string }>('SELECT kind FROM alerts WHERE order_id = $1 ORDER BY kind', [
      order_id,
    ])
  ).map((r) => r.kind);
}
