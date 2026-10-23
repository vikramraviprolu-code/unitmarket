// Test world for BU-4: lane 05b's scripted world, with an order read that LISTS the refunds PayPal
// holds for each capture (ours and the ones made at the dashboard), as purchase_units[].payments
// .refunds[] does. Synthetic rows only, no network. Used by the refunds.remaining tests only.
import type { AuditEntry, Money, OrderRead, RefundStatus } from '@umsbx/contracts';
import { makeWorld as makeOpsWorld } from './ops/support';
import type { OpsWorld } from './ops/support';
import type { WorldOptions } from './support';

export interface RemainingWorld extends OpsWorld {
  /** A refund made at the PayPal dashboard, with any status. */
  dashboard(capture_id: string, minor: number, status?: RefundStatus): string;
  /** What PayPal holds for a capture: captured minus refunds that are COMPLETED or PENDING. */
  remoteRemaining(capture_id: string, captured_minor: number): number;
  /** Every audit record written through the deps. */
  audits: AuditEntry[];
  /** Order reads that reached PayPal since markReads() (the journey that made the world is not counted). */
  reads(): number;
  markReads(): void;
  /** Sends to PayPal, with the amount as sent. */
  sends(): { request_id: string; capture_id: string; amount: Money | null }[];
  /** Forces the answer of the next order reads (in order), then back to the real read. */
  script(...reads: (OrderRead | 'real')[]): void;
  /** The next order reads are returned exactly as given, even when they are not an order read. */
  scriptRaw(...reads: unknown[]): void;
}

export async function makeRemainingWorld(opts: WorldOptions = {}): Promise<RemainingWorld> {
  const w = (await makeOpsWorld(opts)) as RemainingWorld;
  const inner = w.paypal.getOrder.bind(w.paypal);
  const raw: unknown[] = [];
  w.paypal.getOrder = async (id, scenario) => {
    const garbage = raw.shift();
    if (garbage !== undefined) {
      w.paypal.calls.push({ op: 'get', provider_order_id: id, request_id: null, scenario: null });
      return garbage as OrderRead;
    }
    const r = await inner(id, scenario);
    if (r.kind !== 'order') return r;
    return {
      ...r,
      units: r.units.map((u) => ({
        ...u,
        // A scripted read that carries its own list keeps it.
        refunds:
          u.refunds ??
          [...w.refunds.values()]
            .filter((x) => u.capture !== null && x.capture_id === u.capture.capture_id)
            .map((x) => ({ refund_id: x.refund_id, status: x.status, amount: x.amount })),
      })),
    };
  };
  w.scriptRaw = (...reads) => {
    raw.push(...reads);
  };
  let dash = 0;
  w.dashboard = (capture_id, minor, status = 'COMPLETED') => {
    dash += 1;
    const refund_id = `SBXDASHLIST${String(dash).padStart(5, '0')}`;
    w.refunds.set(refund_id, {
      refund_id,
      capture_id,
      request_id: null,
      amount: { currency: 'USD', minor },
      status,
    });
    return refund_id;
  };
  w.remoteRemaining = (capture_id, captured_minor) =>
    captured_minor -
    [...w.refunds.values()]
      .filter(
        (x) => x.capture_id === capture_id && (x.status === 'COMPLETED' || x.status === 'PENDING'),
      )
      .reduce((s, x) => s + x.amount.minor, 0);
  w.audits = [];
  w.deps = {
    ...w.deps,
    audit: {
      record: (_tx, e) => {
        w.audits.push(e);
        return Promise.resolve();
      },
    },
  };
  let baseline = 0;
  w.markReads = () => {
    baseline = w.paypal.count('get');
  };
  w.reads = () => w.paypal.count('get') - baseline;
  w.sends = () => w.refundCalls.map((c) => ({ ...c }));
  w.script = (...reads) => {
    w.paypal.queue.get.push(...reads);
  };
  return w;
}
