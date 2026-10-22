// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/capture.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05a.
// P4: the one gated capture and the recording of its answer. A capture answer is a claim: it is
// stored per unit and never unlocks anything. The provider is called outside any transaction (P14).
import { CaptureResSchema } from '@umsbx/contracts';
import type { CaptureRes, Id, PaymentsDeps, ProviderOrderId } from '@umsbx/contracts';
import { raiseAlert } from './alerts';
import { requestIdFor } from './keys';
import {
  addMs,
  backoffMs,
  canStoreCaptureId,
  insertOperation,
  loadOperation,
  loadUnits,
} from './store';
import type { OrderRow } from './store';

class Lost extends Error {}

export type CaptureOutcome =
  | { kind: 'lost' } // another caller holds the capture; nothing was sent by this one
  | { kind: 'claim' } // a claim is stored; a separate read must follow
  | { kind: 'read_decides' } // PayPal refused in a way only a read can explain
  | { kind: 'unknown' } // timeout, 202, 409 and the like: no read now
  | { kind: 'payer_action'; redirect_url: string | null }
  | { kind: 'not_approved' }
  | { kind: 'frozen' };

/**
 * The gate (nfr.md P3, P4). The capture operation row is inserted `prepared` (once: its request id
 * is unique) and then moved to `sent` by a conditional UPDATE; of any number of concurrent returns
 * exactly one gets a row back and may call PayPal. The order moves awaiting_buyer to
 * capture_requested in the same transaction, so a failure of either rolls back both.
 */
async function gate(
  d: PaymentsDeps,
  order: OrderRow,
): Promise<{ op_id: Id; request_id: string } | null> {
  try {
    return await d.db.transaction(async (tx) => {
      const at = d.clock.now().toISOString();
      const request_id = requestIdFor('capture', order.order_ref);
      await insertOperation(tx, {
        id: d.ids.next('opr'),
        order_id: order.id,
        kind: 'capture',
        state: 'prepared',
        request_id,
        lease_until: addMs(at, d.config.operation_lease_ms),
        reconcile_until: null,
        next_retry_at: null,
        at,
      });
      const op = await loadOperation(tx, order.id, 'capture');
      if (op === null) throw new Error(`capture operation of ${order.id} vanished`);
      const won = await tx.query<{ id: string }>(
        `UPDATE operations SET state = 'sent', first_sent_at = COALESCE(first_sent_at, $2),
           idem_safe_until = COALESCE(idem_safe_until, $3), lease_until = $4, updated_at = $2
         WHERE id = $1 AND state = 'prepared' RETURNING id`,
        [
          op.id,
          at,
          addMs(at, d.config.idem_safe_window_ms),
          addMs(at, d.config.operation_lease_ms),
        ],
      );
      if (won.rows.length === 0) throw new Lost();
      const moved = await tx.query(
        `UPDATE orders SET status = 'capture_requested', updated_at = $2
         WHERE id = $1 AND status = 'awaiting_buyer' RETURNING id`,
        [order.id, at],
      );
      if (moved.rows.length === 0) throw new Lost();
      return { op_id: op.id, request_id };
    });
  } catch (e) {
    if (e instanceof Lost) return null;
    throw e;
  }
}

/** Gate, call, record. At most one call per order in flight (the gate), never inside a transaction. */
export async function captureOnce(
  d: PaymentsDeps,
  order: OrderRow,
  provider_order_id: ProviderOrderId,
  scenario: string | null,
): Promise<CaptureOutcome> {
  const gated = await gate(d, order);
  if (gated === null) return { kind: 'lost' };

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
    const op = await loadOperation(tx, order.id, 'capture', { lock: true });
    if (op === null) throw new Error(`capture operation of ${order.id} vanished`);
    const setOrder = async (status: string, mismatch = false): Promise<void> => {
      await tx.query(
        `UPDATE orders SET status = $2, mismatch = mismatch OR $3, updated_at = $4 WHERE id = $1`,
        [order.id, status, mismatch, at],
      );
    };
    const unknown = async (retryAfter: number | null): Promise<CaptureOutcome> => {
      const until = addMs(op.first_sent_at ?? at, d.config.reconcile_window_ms);
      const wait = Math.max(retryAfter ?? 0, backoffMs(d.config, 1));
      await tx.query(
        `UPDATE operations SET state = 'unknown', lease_until = NULL, reconcile_until = $2, next_retry_at = $3, updated_at = $4 WHERE id = $1`,
        [op.id, until, addMs(at, wait), at],
      );
      await setOrder('unresolved');
      return { kind: 'unknown' };
    };
    const reopen = async (): Promise<void> => {
      // Nothing was captured; the same key and operation serve the next try.
      await tx.query(
        `UPDATE operations SET state = 'prepared', lease_until = $2, updated_at = $3 WHERE id = $1`,
        [op.id, addMs(at, d.config.operation_lease_ms), at],
      );
      await setOrder('awaiting_buyer');
    };

    if (res.kind === 'claim' && res.http !== 202) {
      const units = await loadUnits(tx, order.id);
      const claims = [...res.units].sort((a, b) =>
        a.reference_id < b.reference_id ? -1 : a.reference_id > b.reference_id ? 1 : 0,
      );
      for (const claim of claims) {
        const unit = units.find((u) => u.reference_id === claim.reference_id);
        // A claim for an unknown reference, or for a unit already settled, is ignored: the read
        // will show anything that matters.
        if (
          unit === undefined ||
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
      await tx.query(
        `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1`,
        [op.id, at],
      );
      await setOrder('capture_claimed');
      return { kind: 'claim' };
    }
    if (res.kind === 'claim') return unknown(null); // 202: accepted, no final units
    if (res.kind === 'payer_action') {
      await reopen();
      if (res.redirect_url !== null) {
        await tx.query(
          'UPDATE provider_orders SET approve_url = $2, updated_at = $3 WHERE order_id = $1',
          [order.id, res.redirect_url, at],
        );
      }
      return { kind: 'payer_action', redirect_url: res.redirect_url };
    }
    if (res.kind === 'rejected') {
      if (res.issue === 'ORDER_NOT_APPROVED') {
        await reopen();
        return { kind: 'not_approved' };
      }
      if (res.issue === 'ORDER_ALREADY_CAPTURED') return unknown(null); // treat as an unknown claim
      await tx.query(
        `UPDATE operations SET state = 'failed', failure_reason = $2, lease_until = NULL, next_retry_at = NULL, updated_at = $3 WHERE id = $1`,
        [op.id, res.http === 400 ? 'invalid_request' : 'rejected', at],
      );
      if (res.issue === 'DUPLICATE_INVOICE_ID') {
        await setOrder('frozen', true);
        await raiseAlert(tx, d, {
          kind: 'frozen_order',
          order_id: order.id,
          unit_id: null,
          reason: 'duplicate_invoice_id',
          detail: { debug_id: res.debug_id },
        });
        return { kind: 'frozen' };
      }
      // Any other refusal: the read decides. Declined only when the read shows DECLINED or FAILED.
      await setOrder('unresolved');
      return { kind: 'read_decides' };
    }
    // timeout, unavailable, in_progress (409), blocked, not_found: the capture may have happened.
    return unknown(res.kind === 'unavailable' ? res.retry_after_ms : null);
  });
}
