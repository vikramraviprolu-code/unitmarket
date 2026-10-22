// Refunds, offline (MVP-A, fixtures only), and what a read tells about refunds and reversals.
// Operator only; the switch and the amount are checked before anything is stored; the key is
// derived from the refund request id; a refund is booked in the ledger per refund id only after
// GET refund and a read of the order both show it, and the amount booked is the one GET refund
// returns. A full refund ends access (entitlements revoke the window). A reversal is only ever
// suspected here; `reversed` needs an operator's confirmation (architecture 4.2).
// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/reconcile.ts (refund and reversal
// steps) at a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05b.
import { applyMoneyEvent } from '@umsbx/entitlements';
import { appendLedgerEntry, LedgerRuleError } from '@umsbx/ledger';
import { issueReceiptIfChanged } from '@umsbx/receipts';
import { IdSchema, RefundResSchema, err, ok } from '@umsbx/contracts';
import type {
  Actor,
  CoreDeps,
  Id,
  Money,
  OrderRead,
  PaymentsDeps,
  RefundRes,
  RefundStatus,
  Result,
  SqlExecutor,
} from '@umsbx/contracts';
import { raiseAlert } from './alerts';
import type { AlertKind } from './alerts';
import { requestIdFor } from './keys';
import { addMs, backoffMs, insertOperation, loadOperation } from './store';

/** Kinds this lane adds to the closed set of lane 05a's alerts. Lane 10 reads them as plain text. */
export type OpsAlertKind =
  | AlertKind
  | 'payment_unresolved'
  | 'reversal'
  | 'refund_unbooked'
  | 'refund_failed'
  | 'refund_unresolved';

// ASM-05B-2: lane 05a's AlertKind is a closed union in a file this lane may not edit; the alerts
// table takes any text, so the extra kinds pass through one cast, here. Change request: add the
// five kinds above to AlertKind in alerts.ts.
export async function raiseOpsAlert(
  tx: SqlExecutor,
  d: Pick<CoreDeps, 'clock' | 'ids'>,
  i: {
    kind: OpsAlertKind;
    order_id: Id;
    unit_id: Id | null;
    reason: string;
    detail?: Record<string, string | number | boolean | null>;
  },
): Promise<string | null> {
  return raiseAlert(tx, d, { ...i, kind: i.kind as AlertKind });
}

// A request reserves its amount while it can still become a refund at PayPal.
const OPEN = "('requested', 'sent', 'unknown', 'pending')";
const BOOKABLE = new Set(['captured_verified', 'partially_refunded']);

interface UnitFacts {
  id: Id;
  order_id: Id;
  order_ref: Id;
  currency: string;
  status: string;
  capture_id: string | null;
  amount_minor: number;
  refunded_minor: number;
  verified: boolean;
}
async function loadUnitFacts(
  tx: SqlExecutor,
  unit_id: Id,
  lock: boolean,
): Promise<UnitFacts | null> {
  if (!IdSchema.safeParse(unit_id).success) return null;
  const r = (
    await tx.query<Record<string, unknown>>(
      `SELECT u.id, u.order_id, o.order_ref, o.currency, u.status, u.capture_id, u.amount_minor,
              u.refunded_minor, (u.captured_verified_at IS NOT NULL) AS verified
         FROM order_units u JOIN orders o ON o.id = u.order_id WHERE u.id = $1${
           lock ? ' FOR UPDATE OF u' : ''
         }`,
      [unit_id],
    )
  ).rows[0];
  if (r === undefined) return null;
  return {
    id: r['id'] as string,
    order_id: r['order_id'] as string,
    order_ref: r['order_ref'] as string,
    currency: r['currency'] as string,
    status: r['status'] as string,
    capture_id: (r['capture_id'] as string | null) ?? null,
    amount_minor: Number(r['amount_minor']),
    refunded_minor: Number(r['refunded_minor']),
    verified: r['verified'] === true,
  };
}

// ---------------------------------------------------------------------------------------------
// requestRefund

export async function requestRefund(
  d: PaymentsDeps,
  i: { unit_id: Id; amount: Money | null; reason: string; actor: Actor },
): Promise<
  Result<
    { refund_request_id: Id },
    { code: 'refunds_off' | 'not_captured' | 'over_refund' | 'not_operator' }
  >
> {
  if (i.actor.kind !== 'operator') return err({ code: 'not_operator' });
  // The switch is read outside any transaction: the port may use the database itself.
  if (!(await d.switches.isOn('refunds_enabled'))) return err({ code: 'refunds_off' });
  const actor = i.actor;
  return d.db.transaction(async (tx) => {
    const unit = await loadUnitFacts(tx, i.unit_id, true);
    if (unit === null || !unit.verified || unit.capture_id === null || !BOOKABLE.has(unit.status)) {
      return err({ code: 'not_captured' as const });
    }
    const open = (
      await tx.query<{ n: string | number }>(
        `SELECT COALESCE(sum(amount_minor), 0) AS n FROM refund_requests WHERE unit_id = $1 AND state IN ${OPEN}`,
        [unit.id],
      )
    ).rows[0];
    const remaining = unit.amount_minor - unit.refunded_minor - Number(open?.n ?? 0);
    const minor = i.amount === null ? remaining : i.amount.minor;
    if (
      (i.amount !== null && i.amount.currency !== unit.currency) ||
      !Number.isInteger(minor) ||
      minor <= 0 ||
      minor > remaining
    ) {
      return err({ code: 'over_refund' as const });
    }
    const at = d.clock.now().toISOString();
    const id = d.ids.next('rfr');
    await tx.query(
      `INSERT INTO refund_requests (id, unit_id, capture_id, amount_minor, currency, reason, requested_by, state, refund_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'requested', NULL, $8, $8)`,
      [
        id,
        unit.id,
        unit.capture_id,
        minor,
        unit.currency,
        i.reason,
        `operator:${actor.operator_id}`,
        at,
      ],
    );
    await d.audit.record(tx, {
      actor,
      action: 'refund.requested',
      target: id,
      reason: i.reason,
      detail: { unit_id: unit.id, amount_minor: minor, currency: unit.currency },
    });
    return ok({ refund_request_id: id });
  });
}

// ---------------------------------------------------------------------------------------------
// executeRefund

interface RequestRow {
  id: Id;
  unit_id: Id;
  capture_id: string;
  amount_minor: number;
  currency: string;
  reason: string;
  state: string;
  refund_id: string | null;
}
async function loadRequest(tx: SqlExecutor, id: Id, lock = false): Promise<RequestRow | null> {
  if (!IdSchema.safeParse(id).success) return null;
  const r = (
    await tx.query<Record<string, unknown>>(
      `SELECT id, unit_id, capture_id, amount_minor, currency, reason, state, refund_id FROM refund_requests WHERE id = $1${
        lock ? ' FOR UPDATE' : ''
      }`,
      [id],
    )
  ).rows[0];
  if (r === undefined) return null;
  return {
    id: r['id'] as string,
    unit_id: r['unit_id'] as string,
    capture_id: r['capture_id'] as string,
    amount_minor: Number(r['amount_minor']),
    currency: r['currency'] as string,
    reason: r['reason'] as string,
    state: r['state'] as string,
    refund_id: (r['refund_id'] as string | null) ?? null,
  };
}

const STATUS_OF: Record<string, RefundStatus> = {
  completed: 'COMPLETED',
  pending: 'PENDING',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
};
type Executed = Result<{ status: RefundStatus }, { code: 'unknown' | 'rejected' }>;
const answerOf = (state: string): Executed => {
  const status = STATUS_OF[state];
  if (status !== undefined) return ok({ status });
  return err({ code: state === 'rejected' ? ('rejected' as const) : ('unknown' as const) });
};

export async function executeRefund(
  d: PaymentsDeps,
  i: { refund_request_id: Id; scenario?: string | null },
): Promise<Executed> {
  // Read outside any transaction: the port may use the database itself.
  if (!(await d.switches.isOn('refunds_enabled'))) return err({ code: 'rejected' });
  type Prepared =
    { kind: 'done'; result: Executed } | { kind: 'send'; rq: RequestRow; key: string };
  const prepared = await d.db.transaction(async (tx): Promise<Prepared> => {
    const rq = await loadRequest(tx, i.refund_request_id, true);
    if (rq === null) return { kind: 'done', result: err({ code: 'rejected' }) };
    if (rq.state !== 'requested') return { kind: 'done', result: answerOf(rq.state) };
    const unit = await loadUnitFacts(tx, rq.unit_id, true);
    if (unit === null) return { kind: 'done', result: err({ code: 'rejected' }) };
    const at = d.clock.now().toISOString();
    const key = requestIdFor('refund', rq.id);
    await tx.query(
      `INSERT INTO operations (id, order_id, unit_id, kind, state, attempt, request_id, first_sent_at,
         idem_safe_until, lease_until, next_retry_at, reconcile_until, failure_reason, created_at, updated_at)
       VALUES ($1, $2, $3, 'refund', 'sent', 1, $4, $5, $6, $7, NULL, NULL, NULL, $5, $5)
       ON CONFLICT (request_id) DO NOTHING`,
      [
        d.ids.next('opr'),
        unit.order_id,
        unit.id,
        key,
        at,
        addMs(at, d.config.idem_safe_window_ms),
        addMs(at, d.config.operation_lease_ms),
      ],
    );
    await tx.query("UPDATE refund_requests SET state = 'sent', updated_at = $2 WHERE id = $1", [
      rq.id,
      at,
    ]);
    return { kind: 'send', rq, key };
  });
  if (prepared.kind === 'done') return prepared.result;

  // Outside any transaction (P14). A crash here leaves the operation `sent`; recovery reads.
  const raw = await d.paypal.refundCapture({
    capture_id: prepared.rq.capture_id,
    request_id: prepared.key,
    amount: { currency: prepared.rq.currency, minor: prepared.rq.amount_minor },
    note: prepared.rq.reason,
  });
  const parsed = RefundResSchema.safeParse(raw);
  return recordCall(d, prepared.rq.id, parsed.success ? parsed.data : { kind: 'timeout' });
}

/** Records the answer of a refund call (first send or resend) and, when PayPal accepted it, reads it back. */
async function recordCall(d: PaymentsDeps, request_id: Id, res: RefundRes): Promise<Executed> {
  const outcome = await d.db.transaction(async (tx) => {
    const at = d.clock.now().toISOString();
    const rq = await loadRequest(tx, request_id, true);
    if (rq === null) throw new Error(`refund request ${request_id} vanished`);
    const unit = await loadUnitFacts(tx, rq.unit_id, false);
    if (unit === null) throw new Error(`unit of refund request ${request_id} vanished`);
    const op = await loadOperation(tx, unit.order_id, 'refund');
    if (op === null) throw new Error(`refund operation of ${request_id} vanished`);
    if (res.kind === 'refund') {
      await tx.query(
        "UPDATE refund_requests SET refund_id = $2, state = 'pending', updated_at = $3 WHERE id = $1",
        [rq.id, res.refund_id, at],
      );
      await tx.query(
        `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1`,
        [op.id, at],
      );
      return { kind: 'accepted' as const, refund_id: res.refund_id };
    }
    if (res.kind === 'rejected') {
      await tx.query(
        `UPDATE operations SET state = 'failed', failure_reason = $2, lease_until = NULL, next_retry_at = NULL, updated_at = $3 WHERE id = $1`,
        [op.id, res.http === 400 ? 'invalid_request' : 'rejected', at],
      );
      await tx.query(
        "UPDATE refund_requests SET state = 'rejected', updated_at = $2 WHERE id = $1",
        [rq.id, at],
      );
      return { kind: 'rejected' as const };
    }
    // timeout, unavailable, in_progress, blocked, not_found, payer_action: the refund may exist.
    await tx.query(
      `UPDATE operations SET state = 'unknown', lease_until = NULL, reconcile_until = $2, next_retry_at = $3, updated_at = $4 WHERE id = $1`,
      [
        op.id,
        addMs(op.first_sent_at ?? at, d.config.reconcile_window_ms),
        addMs(at, backoffMs(d.config, op.attempt)),
        at,
      ],
    );
    await tx.query("UPDATE refund_requests SET state = 'unknown', updated_at = $2 WHERE id = $1", [
      rq.id,
      at,
    ]);
    return { kind: 'unknown' as const };
  });
  if (outcome.kind === 'rejected') return err({ code: 'rejected' });
  if (outcome.kind === 'unknown') return err({ code: 'unknown' });
  return readBack(d, request_id);
}

/**
 * GET refund and a read of the order. Nothing is booked unless GET refund says COMPLETED and the
 * order read shows at least that much refunded; the amount booked is GET refund's. Anything else
 * leaves a refund_readback operation polling.
 */
export async function readBack(d: PaymentsDeps, request_id: Id): Promise<Executed> {
  const rq = await loadRequest(d.db, request_id);
  if (rq === null || rq.refund_id === null) return err({ code: 'unknown' });
  const unit = await loadUnitFacts(d.db, rq.unit_id, false);
  if (unit === null) return err({ code: 'unknown' });
  const got = await d.paypal.getRefund(rq.refund_id);
  let status: RefundStatus | null = null;
  let amount: Money | null = null;
  if (got.kind === 'refund') {
    status = got.status;
    amount = got.amount;
  }
  let shown = 0;
  if (status === 'COMPLETED') {
    const provider = (
      await d.db.query<{ provider_order_id: string | null }>(
        'SELECT provider_order_id FROM provider_orders WHERE order_id = $1 ORDER BY id LIMIT 1',
        [unit.order_id],
      )
    ).rows[0]?.provider_order_id;
    const read: OrderRead | null =
      provider === undefined || provider === null ? null : await d.paypal.getOrder(provider);
    if (read !== null && read.kind === 'order') {
      shown =
        read.units.find((u) => u.capture?.capture_id === rq.capture_id)?.capture?.refunded_minor ??
        0;
    }
  }
  return d.db.transaction(async (tx): Promise<Executed> => {
    const at = d.clock.now().toISOString();
    const row = await loadRequest(tx, request_id, true);
    if (row === null) throw new Error(`refund request ${request_id} vanished`);
    // Someone else finished it first.
    if (row.state !== 'pending') return answerOf(row.state);
    const fresh = await loadUnitFacts(tx, row.unit_id, true);
    if (fresh === null) throw new Error(`unit of refund request ${request_id} vanished`);
    const op = await loadOperation(tx, fresh.order_id, 'refund_readback', { lock: true });
    const settle = async (): Promise<void> => {
      if (op !== null && op.state === 'unknown') {
        await tx.query(
          `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1`,
          [op.id, at],
        );
      }
    };
    if (status === 'COMPLETED' && amount !== null && shown >= fresh.refunded_minor + amount.minor) {
      // False means the amount did not fit the unit: an alert is raised and a human decides.
      await book(tx, d, fresh, row.refund_id as string, amount);
      await tx.query(
        "UPDATE refund_requests SET state = 'completed', updated_at = $2 WHERE id = $1",
        [row.id, at],
      );
      await settle();
      return ok({ status: 'COMPLETED' as const });
    }
    if (status === 'FAILED' || status === 'CANCELLED') {
      await tx.query('UPDATE refund_requests SET state = $2, updated_at = $3 WHERE id = $1', [
        row.id,
        status === 'FAILED' ? 'failed' : 'cancelled',
        at,
      ]);
      await settle();
      await raiseOpsAlert(tx, d, {
        kind: 'refund_failed',
        order_id: fresh.order_id,
        unit_id: fresh.id,
        reason: `refund_${status.toLowerCase()}_${row.id}`,
        detail: { refund_request_id: row.id },
      });
      return ok({ status });
    }
    // PENDING, or COMPLETED but not yet shown by the order read, or no usable answer: keep polling.
    if (op === null) {
      await insertOperation(tx, {
        id: d.ids.next('opr'),
        order_id: fresh.order_id,
        kind: 'refund_readback',
        state: 'unknown',
        request_id: `umsRB-${row.id}`,
        lease_until: null,
        reconcile_until: addMs(at, d.config.reconcile_window_ms),
        next_retry_at: addMs(at, backoffMs(d.config, 1)),
        at,
      });
    }
    return ok({ status: 'PENDING' as const });
  });
}

// Books one refund by its id: ledger entry, unit totals, the entitlement of a fully refunded unit,
// a new receipt version. Returns false when the refund could not be booked (alert raised).
async function book(
  tx: SqlExecutor,
  d: CoreDeps,
  unit: UnitFacts,
  refund_id: string,
  amount: Money,
): Promise<boolean> {
  if (
    unit.capture_id === null ||
    !BOOKABLE.has(unit.status) ||
    amount.currency !== unit.currency ||
    amount.minor <= 0 ||
    amount.minor > unit.amount_minor - unit.refunded_minor
  ) {
    await raiseOpsAlert(tx, d, {
      kind: 'refund_unresolved',
      order_id: unit.order_id,
      unit_id: unit.id,
      reason: `cannot_book_${refund_id}`,
      detail: { amount_minor: amount.minor, status: unit.status },
    });
    return false;
  }
  const sale = (
    await tx.query<{ id: string }>(
      "SELECT id FROM ledger_entries WHERE capture_id = $1 AND kind = 'sale'",
      [unit.capture_id],
    )
  ).rows[0];
  let added;
  try {
    added = await appendLedgerEntry(tx, d, {
      unit_id: unit.id,
      capture_id: unit.capture_id,
      kind: 'refund',
      amount,
      refund_id,
      ref_entry_id: sale?.id ?? null,
    });
  } catch (e) {
    // A rule of the ledger (for instance a replay of this refund id with another amount) is a
    // programmer error, not a booking: nothing is written and a human is told.
    if (!(e instanceof LedgerRuleError)) throw e;
    await raiseOpsAlert(tx, d, {
      kind: 'refund_unresolved',
      order_id: unit.order_id,
      unit_id: unit.id,
      reason: `ledger_rule_${refund_id}`,
      detail: { rule: e.message.slice(0, 200) },
    });
    return false;
  }
  if (!added.ok) return true; // booked before: a replay changes nothing
  const total = unit.refunded_minor + amount.minor;
  const full = total >= unit.amount_minor;
  const at = d.clock.now().toISOString();
  await tx.query(
    'UPDATE order_units SET refunded_minor = $2, status = $3, updated_at = $4 WHERE id = $1',
    [unit.id, total, full ? 'refunded' : 'partially_refunded', at],
  );
  if (full) await refundEntitlements(tx, d, unit.id);
  await issueReceiptIfChanged(tx, d, { order_id: unit.order_id });
  return true;
}

async function refundEntitlements(tx: SqlExecutor, d: CoreDeps, unit_id: Id): Promise<void> {
  const ents = await tx.query<{ id: string }>(
    'SELECT id FROM entitlements WHERE unit_id = $1 ORDER BY article_id',
    [unit_id],
  );
  for (const e of ents.rows) {
    // Ends the access window too. A refused transition (already refunded) is not an error.
    await applyMoneyEvent(tx, d, { entitlement_id: e.id, event: 'refund_verified' });
  }
}

// ---------------------------------------------------------------------------------------------
// Resuming refund operations (called by the due-work runner)

export interface RefundOp {
  id: Id;
  order_id: Id;
  kind: 'refund' | 'refund_readback';
  request_id: string;
  attempt: number;
  idem_safe_until: string | null;
}

/** The refund request an operation belongs to: refund keys are `umsR-<id>`, read-backs `umsRB-<id>`. */
const requestOf = (op: Pick<RefundOp, 'request_id'>): Id => op.request_id.replace(/^umsRB?-/, '');

/**
 * One step for a due refund operation: a read-back of a refund PayPal accepted, or the one allowed
 * resend (same key, inside 5 h) of a call whose answer was lost. When neither can go on (the key
 * window passed, or the 24 h window ended) the operation is closed and a human is told.
 */
export async function resumeRefund(d: PaymentsDeps, op: RefundOp, ended: boolean): Promise<void> {
  const request_id = requestOf(op);
  const rq = await loadRequest(d.db, request_id);
  if (rq === null) return;
  if (op.kind === 'refund_readback' || rq.refund_id !== null) {
    const r = await readBack(d, request_id);
    if (r.ok && r.value.status !== 'PENDING') return;
    if (ended) await closeRefundUnknown(d, op, true);
    return;
  }
  const at = d.clock.now().toISOString();
  if (op.idem_safe_until === null || Date.parse(at) >= Date.parse(op.idem_safe_until)) {
    // PayPal may have forgotten the key: never send again.
    await closeRefundUnknown(d, op, ended);
    return;
  }
  const claimed = await d.db.query(
    `UPDATE operations SET state = 'sent', attempt = attempt + 1, lease_until = $2, next_retry_at = NULL, updated_at = $3
     WHERE id = $1 AND state = 'unknown' AND attempt = $4 RETURNING id`,
    [op.id, addMs(at, d.config.operation_lease_ms), at, op.attempt],
  );
  if (claimed.rows.length === 0) return;
  const raw = await d.paypal.refundCapture({
    capture_id: rq.capture_id,
    request_id: op.request_id,
    amount: { currency: rq.currency, minor: rq.amount_minor },
    note: rq.reason,
  });
  const parsed = RefundResSchema.safeParse(raw);
  await recordCall(d, request_id, parsed.success ? parsed.data : { kind: 'timeout' });
}

/**
 * The 5 h key limit passed, or the 24 h window ended, with the outcome of a refund call unknown.
 * One read of the order: a capture refunded for more than UnitMarket booked means a refund exists
 * whose id is unknown, and a human is told. The operation is closed either way; no resend.
 */
export async function closeRefundUnknown(
  d: PaymentsDeps,
  op: RefundOp,
  windowEnded: boolean,
): Promise<boolean> {
  const request_id = requestOf(op);
  const rq = await loadRequest(d.db, request_id);
  if (rq === null) return true;
  const unit = await loadUnitFacts(d.db, rq.unit_id, false);
  if (unit === null) return true;
  let excess: number | null = null;
  if (rq.refund_id === null) {
    const provider = (
      await d.db.query<{ provider_order_id: string | null }>(
        'SELECT provider_order_id FROM provider_orders WHERE order_id = $1 ORDER BY id LIMIT 1',
        [unit.order_id],
      )
    ).rows[0]?.provider_order_id;
    if (provider !== undefined && provider !== null) {
      const read = await d.paypal.getOrder(provider);
      if (read.kind === 'order') {
        const shown =
          read.units.find((u) => u.capture?.capture_id === rq.capture_id)?.capture
            ?.refunded_minor ?? 0;
        excess = shown - unit.refunded_minor;
      }
    }
    // The read failed: try again until the window ends.
    if (excess === null && !windowEnded) return false;
  }
  await d.db.transaction(async (tx) => {
    const at = d.clock.now().toISOString();
    await tx.query(
      `UPDATE operations SET state = 'failed', failure_reason = 'window_expired', lease_until = NULL, next_retry_at = NULL, updated_at = $2
       WHERE id = $1 AND state = 'unknown'`,
      [op.id, at],
    );
    await tx.query(
      "UPDATE refund_requests SET state = 'failed', updated_at = $2 WHERE id = $1 AND state IN ('unknown', 'pending')",
      [rq.id, at],
    );
    if (excess === null || excess > 0) {
      await raiseOpsAlert(tx, d, {
        kind: 'refund_unresolved',
        order_id: unit.order_id,
        unit_id: unit.id,
        reason: `refund_outcome_unknown_${rq.id}`,
        detail: { refund_request_id: rq.id, excess_minor: excess },
      });
    }
  });
  return true;
}

// ---------------------------------------------------------------------------------------------
// What a read tells about refunds and reversals (called inside the reconciler's transaction)

export async function suspectReversalTx(
  tx: SqlExecutor,
  d: CoreDeps,
  i: { capture_id: string; source: string },
): Promise<{ found: boolean; changed: boolean }> {
  const unit = (
    await tx.query<{ id: string; order_id: string; status: string }>(
      'SELECT id, order_id, status FROM order_units WHERE capture_id = $1 FOR UPDATE',
      [i.capture_id],
    )
  ).rows[0];
  if (unit === undefined) return { found: false, changed: false };
  const at = d.clock.now().toISOString();
  const moved = await tx.query(
    `UPDATE order_units SET status = 'reversal_suspected', updated_at = $2
     WHERE id = $1 AND status IN ('captured_verified', 'partially_refunded') RETURNING id`,
    [unit.id, at],
  );
  const changed = moved.rows.length > 0;
  // The alert is raised for the unit in any state (a reversal on a refunded unit is a double loss);
  // a repeat of the same event raises nothing new.
  await raiseOpsAlert(tx, d, {
    kind: 'reversal',
    order_id: unit.order_id,
    unit_id: unit.id,
    reason:
      changed || unit.status === 'reversal_suspected'
        ? 'reversal_suspected'
        : `reversal_on_${unit.status}`,
    detail: { source: i.source, capture_id: i.capture_id },
  });
  return { found: true, changed };
}

/**
 * A PAYMENT.CAPTURE.REVERSED event (or a read showing it): the unit is marked reversal_suspected and
 * a human is alerted. It is never marked reversed here.
 */
export function suspectReversal(
  d: CoreDeps,
  i: { capture_id: string; source: 'webhook' | 'read' | 'manual' },
): Promise<{ found: boolean; changed: boolean }> {
  return d.db.transaction((tx) => suspectReversalTx(tx, d, i));
}

type OrderReadOk = Extract<OrderRead, { kind: 'order' }>;

/**
 * After a read was applied: a verified capture that PayPal now shows as declined or failed is a
 * suspected reversal; a verified capture refunded for more than UnitMarket booked (a refund made at
 * the PayPal dashboard) is alerted, and a full one ends the access, because the money went back.
 */
export async function observeReadback(
  tx: SqlExecutor,
  d: CoreDeps,
  read: OrderReadOk,
): Promise<void> {
  for (const ru of read.units) {
    const cap = ru.capture;
    if (cap === null) continue;
    const unit = (
      await tx.query<{
        id: string;
        order_id: string;
        status: string;
        refunded_minor: number;
        amount_minor: number;
      }>(
        `SELECT id, order_id, status, refunded_minor, amount_minor FROM order_units
          WHERE capture_id = $1 AND captured_verified_at IS NOT NULL`,
        [cap.capture_id],
      )
    ).rows[0];
    if (unit === undefined) continue;
    if (cap.status === 'DECLINED' || cap.status === 'FAILED') {
      await suspectReversalTx(tx, d, { capture_id: cap.capture_id, source: 'read' });
      continue;
    }
    const booked = Number(unit.refunded_minor);
    if (cap.refunded_minor <= booked) continue;
    const open = await tx.query(
      `SELECT 1 FROM refund_requests WHERE unit_id = $1 AND state IN ${OPEN} LIMIT 1`,
      [unit.id],
    );
    if (open.rows.length > 0) continue; // our own refund, still being read back
    await raiseOpsAlert(tx, d, {
      kind: 'refund_unbooked',
      order_id: unit.order_id,
      unit_id: unit.id,
      reason: `refund_unbooked_${cap.refunded_minor}`,
      detail: { shown_minor: cap.refunded_minor, booked_minor: booked, status: cap.status },
    });
    if (cap.status === 'REFUNDED' && BOOKABLE.has(unit.status)) {
      await tx.query("UPDATE order_units SET status = 'refunded', updated_at = $2 WHERE id = $1", [
        unit.id,
        d.clock.now().toISOString(),
      ]);
      await refundEntitlements(tx, d, unit.id);
    }
  }
}
