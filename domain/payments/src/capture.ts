// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/capture.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05a.
// P4: the one gated capture and the recording of its answer, per PayPal order (DP-2a). A capture answer is a claim: it is
// stored per unit and never unlocks anything. The provider is called outside any transaction (P14).
import { CaptureResSchema } from '@umsbx/contracts';
import type { CaptureRes, Id, PaymentsDeps, ProviderOrderId } from '@umsbx/contracts';
import { raiseAlert } from './alerts';
import { lockGraph, poIn, refreshOrder, setPoState } from './composite';
import { captureKeyNumber, requestIdFor } from './keys';
import { ensureReadbackOp } from './apply';
import {
  addMs,
  backoffMs,
  canStoreCaptureId,
  insertOperation,
  loadOperationFor,
  loadProviderOrders,
  loadUnits,
} from './store';
import type { OperationRow, OrderRow, ProviderOrderRow } from './store';

class Lost extends Error {}

export type CaptureOutcome =
  | { kind: 'lost' } // another caller holds the capture; nothing was sent by this one
  | { kind: 'capped' } // the attempts are used up; nothing was sent, a human was alerted
  | { kind: 'blocked' } // the kill switch stopped the call; nothing was sent
  | { kind: 'claim' } // a claim is stored; a separate read must follow
  | { kind: 'read_decides' } // PayPal refused in a way only a read can explain
  | { kind: 'unknown' } // timeout, 202, 409 and the like: no read now
  | { kind: 'payer_action'; redirect_url: string | null }
  | { kind: 'not_approved' }
  | { kind: 'frozen' };

/** The operation as it was before the gate moved it, so a call that was never sent can undo it. */
type Before = Pick<OperationRow, 'attempt' | 'request_id' | 'first_sent_at' | 'idem_safe_until'>;
type Gated =
  | { kind: 'go'; op_id: Id; request_id: string; before: Before }
  | { kind: 'lost' }
  | { kind: 'capped' };

/** An alert reason that tells the PayPal orders of one pack apart (alerts are unique per order and reason). */
export const reasonFor = (
  po: Pick<ProviderOrderRow, 'route' | 'position'>,
  base: string,
): string => (po.route === 'single' ? base : `${base}_p${po.position}`);

/** The PayPal order a caller means: the one given, else the one of the order that holds this PayPal id. */
async function resolvePo(
  d: PaymentsDeps,
  order: OrderRow,
  provider_order_id: string | null,
  po?: ProviderOrderRow,
): Promise<ProviderOrderRow> {
  if (po !== undefined) return po;
  const all = await loadProviderOrders(d.db, order.id);
  const found =
    provider_order_id === null
      ? all[0]
      : (all.find((p) => p.provider_order_id === provider_order_id) ??
        (all.length === 1 ? all[0] : undefined));
  if (found === undefined) throw new Error(`order ${order.id} has no such provider order`);
  return found;
}

/** The capture operation row of one PayPal order, as a SQL filter (a single order keeps its order-wide reading). */
const poFilter = (po: ProviderOrderRow, at: number): { sql: string; params: unknown[] } =>
  po.route === 'single'
    ? { sql: '', params: [] }
    : { sql: ` AND provider_order_ref = $${at}`, params: [po.id] };

/**
 * The cheap pre-gate (review LOW): before a return pays for its pre-capture read it takes a short
 * lease on the capture operation row (a compare-and-set on lease_until). Of 20 concurrent returns
 * one holds the lease and reads; the others answer from the database. The holder gives the lease
 * back with releasePrecheck when it does not go on to capture. A lease that is never given back
 * (a dead process) runs out after operation_lease_ms. For a pack the lease is taken on the capture
 * operation of the PayPal order given (the first one when none is).
 */
export async function claimPrecheck(
  d: PaymentsDeps,
  order: OrderRow,
  po?: ProviderOrderRow,
): Promise<boolean> {
  const target = await resolvePo(d, order, null, po);
  return d.db.transaction(async (tx) => {
    const at = d.clock.now().toISOString();
    const lease = addMs(at, d.config.operation_lease_ms);
    const inserted = await insertOperation(tx, {
      id: d.ids.next('opr'),
      order_id: order.id,
      kind: 'capture',
      state: 'prepared',
      request_id: requestIdFor('capture', target.po_ref),
      lease_until: lease,
      reconcile_until: null,
      next_retry_at: null,
      at,
      provider_order_ref: target.id,
    });
    if (inserted) return true;
    const f = poFilter(target, 4);
    const won = await tx.query(
      `UPDATE operations SET lease_until = $2, updated_at = $3
       WHERE order_id = $1 AND kind = 'capture' AND state = 'prepared' AND lease_until <= $3${f.sql} RETURNING id`,
      [order.id, lease, at, ...f.params],
    );
    return won.rows.length > 0;
  });
}

export async function releasePrecheck(
  d: PaymentsDeps,
  order: OrderRow,
  po?: ProviderOrderRow,
): Promise<void> {
  const target = await resolvePo(d, order, null, po);
  const at = d.clock.now().toISOString();
  const f = poFilter(target, 3);
  await d.db.query(
    `UPDATE operations SET lease_until = $2, updated_at = $2
     WHERE order_id = $1 AND kind = 'capture' AND state = 'prepared'${f.sql}`,
    [order.id, at, ...f.params],
  );
}

/**
 * The gate (nfr.md P3, P4, D-014). The capture operation row of the PayPal order is inserted
 * `prepared` (once: its request id is unique) and then moved to `sent` by a conditional UPDATE; of
 * any number of concurrent returns exactly one gets a row back and may call PayPal. The gate keys on
 * the PayPal order's own state: it must be `approved`, and it moves to `capture_requested` in the
 * same transaction as the operation's prepared to sent, so a failure of either rolls back both. The
 * order status is then derived (composite.ts), never set here.
 *
 * A try after a definitive answer (payer_action, ORDER_NOT_APPROVED) is a new attempt with a new
 * key umsK-<po_ref>-<n>: PayPal replays the stored answer for a key it has seen, and the old key may
 * be past its 6 h retention. The caller has read the order just before and seen no capture. At most
 * 1 + max_capture_retries keys are ever used per PayPal order; after that nothing is sent and a human
 * is alerted.
 */
async function gate(d: PaymentsDeps, order: OrderRow, target: ProviderOrderRow): Promise<Gated> {
  try {
    return await d.db.transaction(async (tx): Promise<Gated> => {
      const at = d.clock.now().toISOString();
      // Lock order first (orders, provider_orders, operations): the order every other writer uses.
      const po = poIn(await lockGraph(tx, order.id), target.id);
      if (po.state !== 'approved') throw new Lost();
      let op = await loadOperationFor(tx, po, 'capture', { lock: true });
      if (op === null) {
        await insertOperation(tx, {
          id: d.ids.next('opr'),
          order_id: order.id,
          kind: 'capture',
          state: 'prepared',
          request_id: requestIdFor('capture', po.po_ref),
          lease_until: addMs(at, d.config.operation_lease_ms),
          reconcile_until: null,
          next_retry_at: null,
          at,
          provider_order_ref: po.id,
        });
        op = await loadOperationFor(tx, po, 'capture', { lock: true });
      }
      if (op === null) throw new Error(`capture operation of ${po.id} vanished`);
      if (op.state !== 'prepared') throw new Lost();
      const sentBefore = op.first_sent_at !== null;
      const attempt = sentBefore ? op.attempt + 1 : op.attempt;
      // D-014: the cap counts keys, not sends. A same-key resend (a lost answer) is not a new
      // attempt; the total of sends is bounded separately.
      const keyNumber = captureKeyNumber(po.po_ref, op.request_id) + (sentBefore ? 1 : 0);
      if (
        keyNumber > 1 + d.config.max_capture_retries ||
        attempt > 2 * (1 + d.config.max_capture_retries)
      ) {
        await raiseAlert(tx, d, {
          kind: 'payment_unresolved',
          order_id: order.id,
          unit_id: null,
          reason: reasonFor(po, 'capture_attempts_exhausted'),
          detail: { attempt: op.attempt },
        });
        return { kind: 'capped' };
      }
      const request_id = requestIdFor('capture', po.po_ref, keyNumber);
      const won = await tx.query(
        `UPDATE operations SET state = 'sent', attempt = $5, request_id = $6, first_sent_at = $2,
           idem_safe_until = $3, lease_until = $4, updated_at = $2
         WHERE id = $1 AND state = 'prepared' AND attempt = $7 RETURNING id`,
        [
          op.id,
          at,
          addMs(at, d.config.idem_safe_window_ms),
          addMs(at, d.config.operation_lease_ms),
          attempt,
          request_id,
          op.attempt,
        ],
      );
      if (won.rows.length === 0) throw new Lost();
      if (!(await setPoState(tx, po.id, 'capture_requested', at, ['approved']))) throw new Lost();
      await refreshOrder(tx, d, order.id);
      return {
        kind: 'go',
        op_id: op.id,
        request_id,
        before: {
          attempt: op.attempt,
          request_id: op.request_id,
          first_sent_at: op.first_sent_at,
          idem_safe_until: op.idem_safe_until,
        },
      };
    });
  } catch (e) {
    if (e instanceof Lost) return { kind: 'lost' };
    throw e;
  }
}

/**
 * Gate, call, record. At most one call per PayPal order in flight (the gate), never inside a
 * transaction. Every answer changes the state of THAT PayPal order only; the order status follows
 * from deriveOrderStatus. `po` names the PayPal order; when omitted it is the one of this order that
 * holds `provider_order_id`.
 */
export async function captureOnce(
  d: PaymentsDeps,
  order: OrderRow,
  provider_order_id: ProviderOrderId,
  scenario: string | null,
  po?: ProviderOrderRow,
): Promise<CaptureOutcome> {
  const target = await resolvePo(d, order, provider_order_id, po);
  const gated = await gate(d, order, target);
  if (gated.kind !== 'go') return gated;

  // Outside any transaction (P14). If the process dies here the operation stays `sent`: the
  // reconciler turns it `unknown` and reads first; nothing is ever captured a second time.
  const raw = await d.paypal.captureOrder({
    provider_order_id,
    request_id: gated.request_id,
    scenario,
  });
  const parsed = CaptureResSchema.safeParse(raw);
  const res: CaptureRes = parsed.success ? parsed.data : { kind: 'timeout' };

  return d.db.transaction(async (tx): Promise<CaptureOutcome> => {
    const at = d.clock.now().toISOString();
    // The answer is recorded under the same lock order as everything else: order, provider orders,
    // operations. The PayPal order may have moved on while the call was open (a concurrent read froze
    // it, a poll verified it, the sweeper gave the call up): the answer then changes the operation only.
    const graph = await lockGraph(tx, order.id);
    const current = graph.order;
    const po = poIn(graph, target.id);
    const op = await loadOperationFor(tx, po, 'capture', { lock: true });
    if (op === null) throw new Error(`capture operation of ${po.id} vanished`);
    const live = po.state === 'capture_requested';
    const money = po.state === 'captured';
    // Guarded: only the state this call set may be left by this call (H1, M2). Writes this PayPal
    // order's state only, then the order status is derived.
    const setState = async (
      state: 'unresolved' | 'capture_claimed' | 'approved' | 'frozen',
    ): Promise<void> => {
      if (!live) return;
      if (await setPoState(tx, po.id, state, at, ['capture_requested'])) {
        await refreshOrder(tx, d, order.id);
      }
    };
    const setOp = async (set: string, params: unknown[] = []): Promise<void> => {
      await tx.query(
        `UPDATE operations SET ${set}, updated_at = $2 WHERE id = $1 AND state IN ('sent', 'unknown')`,
        [op.id, at, ...params],
      );
    };
    // A PayPal order that is no longer ours: the operation is closed to match where it stands.
    const settleDead = async (): Promise<void> => {
      if (money) {
        await setOp("state = 'confirmed', lease_until = NULL, next_retry_at = NULL");
      } else if (po.state === 'frozen' || po.state === 'failed' || po.state === 'declined') {
        await setOp(
          "state = 'failed', failure_reason = $3, lease_until = NULL, next_retry_at = NULL",
          [po.state === 'frozen' ? 'mismatch' : 'declined'],
        );
      } else if (po.state === 'abandoned') {
        await setOp(
          "state = 'failed', failure_reason = 'declined', lease_until = NULL, next_retry_at = NULL",
        );
      }
    };
    const unknown = async (retryAfter: number | null): Promise<CaptureOutcome> => {
      if (!live) {
        await settleDead();
        return { kind: 'unknown' };
      }
      const until = addMs(op.first_sent_at ?? at, d.config.reconcile_window_ms);
      const wait = Math.max(retryAfter ?? 0, backoffMs(d.config, 1));
      await setOp(
        "state = 'unknown', lease_until = NULL, reconcile_until = $3, next_retry_at = $4",
        [until, addMs(at, wait)],
      );
      await setState('unresolved');
      return { kind: 'unknown' };
    };
    const reopen = async (): Promise<boolean> => {
      if (!live) {
        await settleDead();
        return false;
      }
      // Nothing was captured; the operation keeps its attempt count and the next try is a new
      // attempt (see gate). The lease is over: the next return may take the pre-gate at once.
      await setOp("state = 'prepared', lease_until = $2");
      await setState('approved');
      return true;
    };
    const notLive = (): CaptureOutcome =>
      po.state === 'frozen' ? { kind: 'frozen' } : { kind: 'lost' };

    if (res.kind === 'claim' && res.http !== 202) {
      const units = await loadUnits(tx, order.id);
      const claims = [...res.units].sort((a, b) =>
        a.reference_id < b.reference_id ? -1 : a.reference_id > b.reference_id ? 1 : 0,
      );
      for (const claim of claims) {
        const unit = units.find((u) => u.reference_id === claim.reference_id);
        // A claim for an unknown reference, for a unit of another PayPal order, or for a unit already
        // settled, is ignored: the read will show anything that matters.
        if (
          unit === undefined ||
          unit.provider_order_ref !== po.id ||
          unit.captured_verified_at !== null ||
          unit.status === 'mismatch'
        ) {
          continue;
        }
        const store =
          claim.capture_id !== null && (await canStoreCaptureId(tx, unit.id, claim.capture_id));
        // The id is held by another unit: never stored twice; the read will show the clash.
        await tx.query(
          `UPDATE order_units SET capture_id = COALESCE($2, capture_id), status_reason = $3, updated_at = $4
           WHERE id = $1 AND captured_verified_at IS NULL AND status IN ('expected', 'pending')`,
          [unit.id, store ? claim.capture_id : null, `claim:${claim.status ?? 'none'}`, at],
        );
      }
      await setOp("state = 'confirmed', lease_until = NULL, next_retry_at = NULL");
      await setState('capture_claimed');
      // H-1: the claim is stored together with the thing that will read it back. If the process
      // dies before the post-capture read, the poll of this operation finishes the PayPal order.
      if (live) await ensureReadbackOp(tx, d, current, at, po);
      return { kind: 'claim' };
    }
    if (res.kind === 'claim') return unknown(null); // 202: accepted, no final units
    if (res.kind === 'blocked') {
      // The kill switch stopped the call: nothing was sent, so the attempt is not spent.
      if (!live) {
        await settleDead();
        return notLive();
      }
      await tx.query(
        `UPDATE operations SET state = 'prepared', attempt = $2, request_id = $3, first_sent_at = $4,
           idem_safe_until = $5, lease_until = $6, updated_at = $6
         WHERE id = $1 AND state = 'sent'`,
        [
          op.id,
          gated.before.attempt,
          gated.before.request_id,
          gated.before.first_sent_at,
          gated.before.idem_safe_until,
          at,
        ],
      );
      await setState('approved');
      return { kind: 'blocked' };
    }
    if (res.kind === 'payer_action') {
      const reopened = await reopen();
      if (!reopened) return notLive();
      if (res.redirect_url !== null) {
        // This PayPal order's approve url only: the buyer approves this one again.
        await tx.query(
          'UPDATE provider_orders SET approve_url = $2, updated_at = $3 WHERE id = $1',
          [po.id, res.redirect_url, at],
        );
      }
      return { kind: 'payer_action', redirect_url: res.redirect_url };
    }
    if (res.kind === 'rejected') {
      if (res.issue === 'ORDER_NOT_APPROVED') {
        const reopened = await reopen();
        return reopened ? { kind: 'not_approved' } : notLive();
      }
      if (res.issue === 'ORDER_ALREADY_CAPTURED') return unknown(null); // treat as an unknown claim
      await setOp(
        "state = 'failed', failure_reason = $3, lease_until = NULL, next_retry_at = NULL",
        [res.http === 400 ? 'invalid_request' : 'rejected'],
      );
      if (res.issue === 'DUPLICATE_INVOICE_ID') {
        await setState('frozen');
        await raiseAlert(tx, d, {
          kind: 'frozen_order',
          order_id: order.id,
          unit_id: null,
          reason: reasonFor(po, 'duplicate_invoice_id'),
          detail: { debug_id: res.debug_id },
        });
        return { kind: 'frozen' };
      }
      if (res.http === 400) {
        // A malformed request cannot have captured: no retry, a human looks (error table).
        await raiseAlert(tx, d, {
          kind: 'payment_unresolved',
          order_id: order.id,
          unit_id: null,
          reason: reasonFor(po, 'capture_invalid_request'),
          detail: { debug_id: res.debug_id },
        });
      }
      // Any other refusal: the read decides. The PayPal order is closed as not charged only when the
      // read shows no capture (applyReadback), declined only when it shows DECLINED or FAILED.
      if (!live) return notLive();
      await setState('unresolved');
      return { kind: 'read_decides' };
    }
    // timeout, unavailable, in_progress (409), not_found: the capture may have happened.
    return unknown(res.kind === 'unavailable' ? res.retry_after_ms : null);
  });
}
