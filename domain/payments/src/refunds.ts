// Refunds, offline (MVP-A, fixtures only), and what a read tells about refunds and reversals.
// Operator only, with MFA (P9); the switch and the amount are checked before anything is stored; one
// request per unit is open at a time (CO-4); the key is derived from the refund request id; a refund
// is booked in the ledger per refund id only after GET refund and a read of the order both show it,
// and the amount booked is the one GET refund returns. A refund made at the PayPal dashboard is
// booked from the order's own refund list (ASM-53) once a read shows it COMPLETED. The unit status
// follows the ledger sums (D-019): below the captured amount it is partially_refunded and access
// continues (ASM-59); equal, it is refunded and the entitlements revoke the window. A reversal is
// only ever suspected here; `reversed` needs an operator's confirmation (architecture 4.2).
// A refund list that does not add up FREEZES the order (orders.mismatch plus a frozen_order alert):
// requestRefund then answers unit_frozen. Nothing here ever clears the flag, not even a later clean
// read; a human does. Access is never changed by a freeze. A request that was never executed can be
// cancelled (cancelRefundRequest), which frees the unit.
// MVP-D (DP-3): a pack has one PayPal order per publisher. Every refund read goes to the PayPal order
// of the unit itself (providerOrderIdOfUnit), and a frozen SIBLING PayPal order does not freeze the
// refund of a captured unit (frozenForUnit). A refund never touches the other unit.
// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/reconcile.ts (refund and reversal
// steps) at a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05b.
import { applyMoneyEvent } from '@umsbx/entitlements';
import { appendLedgerEntry, LedgerRuleError } from '@umsbx/ledger';
import { issueReceiptIfChanged } from '@umsbx/receipts';
import {
  IdSchema,
  OrderReadSchema,
  RefundResSchema,
  RefundStatusSchema,
  err,
  ok,
} from '@umsbx/contracts';
import type {
  Actor,
  CoreDeps,
  Id,
  Money,
  OrderRead,
  OrderReadRefund,
  PaymentsDeps,
  RefundRes,
  RefundStatus,
  Result,
  SqlExecutor,
} from '@umsbx/contracts';
import { raiseAlert } from './alerts';
import type { AlertKind } from './alerts';
import { refundReadbackKeyFor, requestIdFor } from './keys';
import {
  addMs,
  backoffMs,
  insertOperation,
  loadOperationByRequestId,
  lockOrderOfUnit,
  lockOrderRows,
} from './store';

/** Kept as an alias: the kinds lane 05b raises are part of lane 05a's AlertKind. */
export type OpsAlertKind = AlertKind;

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
  return raiseAlert(tx, d, i);
}

// A request reserves its amount while it can still become a refund at PayPal. `unresolved` is a
// request whose outcome nobody could prove at the end of the window: PayPal may have refunded, so
// the amount stays reserved until a human decides (M-2).
const OPEN = "('requested', 'sent', 'unknown', 'pending', 'unresolved')";
// A request that blocks the next one for the same unit: it is alive, and its outcome is not settled
// by a human (an `unresolved` one keeps its amount reserved, above, but no longer blocks).
const IN_FLIGHT = "('requested', 'sent', 'unknown', 'pending')";
const REFUNDED_STATUS = new Set(['PARTIALLY_REFUNDED', 'REFUNDED']);
const BOOKABLE = new Set(['captured_verified', 'partially_refunded']);

interface UnitFacts {
  id: Id;
  order_id: Id;
  order_ref: Id;
  publisher_id: Id;
  currency: string;
  status: string;
  capture_id: string | null;
  amount_minor: number;
  refunded_minor: number;
  verified: boolean;
  /** The unit's own PayPal order (order_units.provider_order_ref); null on an old row. */
  provider_order_ref: Id | null;
}
async function loadUnitFacts(
  tx: SqlExecutor,
  unit_id: Id,
  lock: boolean,
): Promise<UnitFacts | null> {
  if (!IdSchema.safeParse(unit_id).success) return null;
  const r = (
    await tx.query<Record<string, unknown>>(
      `SELECT u.id, u.order_id, o.order_ref, u.publisher_id, o.currency, u.status, u.capture_id, u.amount_minor,
              u.refunded_minor, (u.captured_verified_at IS NOT NULL) AS verified, u.provider_order_ref
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
    publisher_id: r['publisher_id'] as string,
    currency: r['currency'] as string,
    status: r['status'] as string,
    capture_id: (r['capture_id'] as string | null) ?? null,
    amount_minor: Number(r['amount_minor']),
    refunded_minor: Number(r['refunded_minor']),
    verified: r['verified'] === true,
    provider_order_ref: (r['provider_order_ref'] as string | null) ?? null,
  };
}

/**
 * The PayPal order id of a unit's OWN PayPal order (DP-3, OQ-10). A pack has one PayPal order per
 * publisher, and a capture is listed only on the order it was made on, so every refund read goes to
 * `order_units.provider_order_ref`, never to the first PayPal order of the order. A unit with no
 * stored reference falls back to the order's only `single` PayPal order (a row from before MVP-D);
 * beside a `per_publisher` order it has no PayPal order and the caller treats the read as unusable
 * (nothing is sent on it). Null when the PayPal order has no PayPal id yet.
 */
async function providerOrderIdOfUnit(
  db: Pick<SqlExecutor, 'query'>,
  unit_id: Id,
): Promise<string | null> {
  const found = await db.query<{ provider_order_id: string | null }>(
    `SELECT p.provider_order_id FROM order_units u
       JOIN provider_orders p ON p.order_id = u.order_id
        AND (p.id = u.provider_order_ref OR (u.provider_order_ref IS NULL AND p.route = 'single'))
      WHERE u.id = $1 ORDER BY p.position`,
    [unit_id],
  );
  return found.rows[0]?.provider_order_id ?? null;
}

/**
 * Does the order's hold stop a refund of THIS unit? `orders.mismatch` is one flag for the whole order.
 * In a pack it is also set when the OTHER publisher's PayPal order is frozen (DP-3): that hold is
 * about the other unit, so it does not block the refund of a unit whose own PayPal order captured.
 * The flag is explained by the sibling alone only when all of this holds: the order is a pack, the
 * unit's own PayPal order is captured, at least one other PayPal order is frozen, and every
 * frozen_order alert of the order belongs to a frozen sibling (its unit is on a frozen sibling, or it
 * carries the sibling's `_p<position>` suffix) and none comes from a refund list. Any other flag, an
 * alert of the unit's own side or of a refund list, an unreadable case, keeps the whole order held.
 */
async function frozenForUnit(
  tx: SqlExecutor,
  unit: Pick<UnitFacts, 'id' | 'order_id' | 'provider_order_ref'>,
): Promise<boolean> {
  const flagged = await tx.query('SELECT 1 FROM orders WHERE id = $1 AND mismatch = true', [
    unit.order_id,
  ]);
  if (flagged.rows.length === 0) return false;
  const pos = (
    await tx.query<{ id: string; state: string; position: number; route: string }>(
      'SELECT id, state, position, route FROM provider_orders WHERE order_id = $1',
      [unit.order_id],
    )
  ).rows;
  const own = pos.find((p) => p.id === unit.provider_order_ref);
  const siblings = pos.filter((p) => p.id !== unit.provider_order_ref && p.state === 'frozen');
  // a unit with no stored PayPal order has no own order here: the whole order stays held
  if (own === undefined || own.route !== 'per_publisher' || own.state !== 'captured') return true;
  if (siblings.length === 0) return true;
  const siblingUnits = new Set(
    (
      await tx.query<{ id: string }>(
        'SELECT id FROM order_units WHERE order_id = $1 AND provider_order_ref = ANY($2::text[])',
        [unit.order_id, siblings.map((p) => p.id)],
      )
    ).rows.map((r) => r.id),
  );
  const alerts = await tx.query<{
    unit_id: string | null;
    reason: string | null;
    source: string | null;
  }>(
    `SELECT unit_id, detail ->> 'reason' AS reason, detail ->> 'source' AS source
       FROM alerts WHERE order_id = $1 AND kind = 'frozen_order'`,
    [unit.order_id],
  );
  const theirs = (a: (typeof alerts.rows)[number]): boolean =>
    a.source !== 'refund_list' &&
    (a.unit_id !== null
      ? siblingUnits.has(a.unit_id)
      : a.reason !== null && siblings.some((p) => a.reason?.endsWith(`_p${p.position}`) === true));
  return !alerts.rows.every(theirs);
}

// ---------------------------------------------------------------------------------------------
// requestRefund

export async function requestRefund(
  d: PaymentsDeps,
  i: { unit_id: Id; amount: Money | null; reason: string; actor: Actor },
): Promise<
  Result<
    { refund_request_id: Id },
    {
      code:
        | 'refunds_off'
        | 'not_captured'
        | 'over_refund'
        | 'not_operator'
        | 'mfa_required'
        | 'refund_in_flight'
        | 'unit_frozen';
    }
  >
> {
  if (i.actor.kind !== 'operator') return err({ code: 'not_operator' });
  // P9: a refund moves money, so the operator must have passed MFA. Strict: only `true` counts.
  if (i.actor.mfa !== true) return err({ code: 'mfa_required' });
  // The switch is read outside any transaction: the port may use the database itself.
  if (!(await d.switches.isOn('refunds_enabled'))) return err({ code: 'refunds_off' });
  const actor = i.actor;
  // "Refund the rest" is what PayPal still holds, which can be less than the local remaining after
  // a refund made at the dashboard. PayPal is read before the transaction (the port may use the
  // database); a read that cannot be used leaves the local remaining, and the check before the
  // first send still protects the amount.
  const remote = i.amount === null ? await remoteForUnit(d, i.unit_id) : null;
  return d.db.transaction(async (tx) => {
    // Lock order: the order of the unit first (store.ts lockOrderRows).
    if (IdSchema.safeParse(i.unit_id).success) await lockOrderOfUnit(tx, i.unit_id);
    const unit = await loadUnitFacts(tx, i.unit_id, true);
    if (unit === null || !unit.verified || unit.capture_id === null || !BOOKABLE.has(unit.status)) {
      return err({ code: 'not_captured' as const });
    }
    // A frozen order (a refund list that did not add up) takes no new request until a human clears it.
    if (await frozenForUnit(tx, unit)) return err({ code: 'unit_frozen' as const });
    // One open request per unit: a double click and a partial-then-remainder sequence cannot overlap.
    const inFlight = await tx.query(
      `SELECT 1 FROM refund_requests WHERE unit_id = $1 AND state IN ${IN_FLIGHT} LIMIT 1`,
      [unit.id],
    );
    if (inFlight.rows.length > 0) return err({ code: 'refund_in_flight' as const });
    const open = (
      await tx.query<{ n: string | number }>(
        `SELECT COALESCE(sum(amount_minor), 0) AS n FROM refund_requests WHERE unit_id = $1 AND state IN ${OPEN}`,
        [unit.id],
      )
    ).rows[0];
    // D-019: the ledger decides what is refunded, not the column.
    const remaining =
      unit.amount_minor - (await ledgerRefunded(tx, unit.id)) - Number(open?.n ?? 0);
    let minor: number;
    if (i.amount !== null) {
      minor = i.amount.minor;
    } else if (remote !== null && remote.kind === 'ok') {
      // The rest: the smaller of what we think is left and what PayPal says is left, less our own
      // refunds its list may not show yet.
      const theirs =
        remote.remaining_minor - (await inFlightMinor(tx, unit.id, '' as Id, remote.listed));
      minor = Math.min(remaining, theirs);
    } else {
      minor = remaining;
    }
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
// cancelRefundRequest

/**
 * Withdraws a request that was never executed (state `requested`, no refund id): it becomes
 * `cancelled`, its reservation is freed, the operation that waits to send it (a put-off send) is
 * closed so the due pass never sends it late, and the audit log says who. Operator with MFA only. It
 * needs no switch: an operator must be able to clear a request while refunds are paused. A request
 * that was sent, is pending, unknown or settled is not touched (wrong_state).
 */
export async function cancelRefundRequest(
  d: PaymentsDeps,
  request_id: string,
  actor: Actor,
): Promise<
  Result<
    { refund_request_id: Id },
    { code: 'not_operator' | 'mfa_required' | 'not_found' | 'wrong_state' }
  >
> {
  if (actor.kind !== 'operator') return err({ code: 'not_operator' });
  if (actor.mfa !== true) return err({ code: 'mfa_required' });
  if (!IdSchema.safeParse(request_id).success) return err({ code: 'not_found' });
  const peek = await loadRequest(d.db, request_id);
  if (peek === null) return err({ code: 'not_found' });
  return d.db.transaction(async (tx) => {
    // Lock order: the order and its operations, then the unit, then the request.
    await lockOrderOfUnit(tx, peek.unit_id);
    const unit = await loadUnitFacts(tx, peek.unit_id, true);
    const rq = await loadRequest(tx, request_id, true);
    if (unit === null || rq === null) return err({ code: 'not_found' as const });
    if (rq.state !== 'requested' || rq.refund_id !== null)
      return err({ code: 'wrong_state' as const });
    const at = d.clock.now().toISOString();
    await tx.query(
      "UPDATE refund_requests SET state = 'cancelled', updated_at = $2 WHERE id = $1",
      [rq.id, at],
    );
    const op = await loadOperationByRequestId(tx, requestIdFor('refund', rq.id), { lock: true });
    if (op !== null && op.state === 'unknown') {
      await tx.query(
        `UPDATE operations SET state = 'failed', failure_reason = 'invalid_request', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1`,
        [op.id, at],
      );
    }
    await d.audit.record(tx, {
      actor,
      action: 'refund.cancelled',
      target: rq.id,
      reason: null,
      detail: { unit_id: unit.id, amount_minor: rq.amount_minor, currency: rq.currency },
    });
    return ok({ refund_request_id: rq.id });
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

// ---------------------------------------------------------------------------------------------
// What PayPal itself still holds (BU-4, ASM-53)
//
// A refund made at the PayPal dashboard is invisible to the local remaining amount. Before the
// first send, the order is read and the stored request amount is compared with PayPal's own
// remaining amount: the captured amount minus the refunds listed as COMPLETED or PENDING. Above it,
// nothing is sent and the request is closed. Without a usable read, nothing is sent either.

/** A read of the order at most this old is reused for the check. */
const REMOTE_READ_REUSE_MS = 60_000;

// Per PayPal port, so two apps in one process (or two tests) never share a read. A cache miss only
// costs a read; no answer depends on it being filled.
const recentReads = new WeakMap<object, Map<string, { at: number; read: OrderReadOk }>>();

/** The order as PayPal shows it now, or a read taken within the last 60 s. Null when unusable. */
async function readOrderForRefund(
  d: PaymentsDeps,
  provider_order_id: string,
): Promise<OrderReadOk | null> {
  const kept = recentReads.get(d.paypal) ?? new Map<string, { at: number; read: OrderReadOk }>();
  recentReads.set(d.paypal, kept);
  const now = d.clock.now().getTime();
  const hit = kept.get(provider_order_id);
  if (hit !== undefined && now - hit.at >= 0 && now - hit.at <= REMOTE_READ_REUSE_MS) {
    return hit.read;
  }
  let raw: unknown;
  try {
    raw = await d.paypal.getOrder(provider_order_id);
  } catch {
    return null; // a read that fails is not a licence to send
  }
  const parsed = OrderReadSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.kind !== 'order' ||
    parsed.data.provider_order_id !== provider_order_id
  ) {
    return null;
  }
  for (const [key, entry] of kept) {
    if (now - entry.at > REMOTE_READ_REUSE_MS || now - entry.at < 0) kept.delete(key); // too old to be reused
  }
  kept.set(provider_order_id, { at: now, read: parsed.data });
  return parsed.data;
}

/** What one read says: captured, remaining (negative when PayPal lists more than was captured), and the refund ids it lists. */
interface RemoteOk {
  kind: 'ok';
  captured_minor: number;
  remaining_minor: number;
  listed: ReadonlySet<string>;
}
type Remote = RemoteOk | { kind: 'unavailable' };

/** PayPal's remaining amount for the capture of a request. Negative when PayPal holds more refunds than captured. */
async function remoteRemaining(
  d: PaymentsDeps,
  rq: Pick<RequestRow, 'unit_id' | 'capture_id' | 'currency'>,
): Promise<Remote> {
  const found = await providerOrderIdOfUnit(d.db, rq.unit_id);
  if (found === null) return { kind: 'unavailable' };
  const read = await readOrderForRefund(d, found);
  if (read === null) return { kind: 'unavailable' };
  const unit = read.units.find((u) => u.capture?.capture_id === rq.capture_id);
  const captured = unit?.capture?.amount;
  if (unit === undefined || captured === undefined || captured.currency !== rq.currency) {
    return { kind: 'unavailable' };
  }
  let held = 0;
  const listed = new Set<string>();
  for (const x of unit.refunds ?? []) {
    if (x.amount.currency !== captured.currency) return { kind: 'unavailable' };
    listed.add(x.refund_id);
    // A refund id listed twice is counted twice: the conservative reading.
    if (x.status === 'COMPLETED' || x.status === 'PENDING') held += x.amount.minor;
  }
  return {
    kind: 'ok',
    captured_minor: captured.minor,
    remaining_minor: captured.minor - held,
    listed,
  };
}

/** PayPal's remaining amount for a unit that is not yet the subject of a request (null: nothing to ask). */
async function remoteForUnit(d: PaymentsDeps, unit_id: Id): Promise<Remote | null> {
  const unit = await loadUnitFacts(d.db, unit_id, false);
  if (unit === null || !unit.verified || unit.capture_id === null) return null;
  return remoteRemaining(d, {
    unit_id: unit.id,
    capture_id: unit.capture_id,
    currency: unit.currency,
  });
}

/** The read that let a request through, kept for the check under the lock. */
type Gate = RemoteOk;

/**
 * Closes a request that asks for more than PayPal holds: `failed` (reservation freed), its put-off
 * operation closed, one refund_unbooked alert and an audit entry. Nothing was sent. When PayPal
 * lists more refunds than it captured, the alert has its own reason and the real (negative)
 * number: that is a fact for a human, not a case to clamp.
 */
async function closeOver(
  tx: SqlExecutor,
  d: PaymentsDeps,
  unit: UnitFacts,
  rq: RequestRow,
  f: { remaining_minor: number; captured_minor: number; in_flight_minor: number },
): Promise<void> {
  const at = d.clock.now().toISOString();
  await tx.query("UPDATE refund_requests SET state = 'failed', updated_at = $2 WHERE id = $1", [
    rq.id,
    at,
  ]);
  const op = await loadOperationByRequestId(tx, requestIdFor('refund', rq.id), { lock: true });
  if (op !== null && op.state === 'unknown') {
    await tx.query(
      `UPDATE operations SET state = 'failed', failure_reason = 'invalid_request', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1`,
      [op.id, at],
    );
  }
  const exceeds = f.remaining_minor < 0;
  await raiseOpsAlert(tx, d, {
    kind: 'refund_unbooked',
    order_id: unit.order_id,
    unit_id: unit.id,
    reason: exceeds ? 'remote_refunds_exceed_capture' : `over_refund_remote_${rq.id}`,
    detail: {
      refund_request_id: rq.id,
      requested_minor: rq.amount_minor,
      captured_minor: f.captured_minor,
      remote_remaining_minor: f.remaining_minor,
      ...(exceeds ? {} : { in_flight_minor: f.in_flight_minor }),
    },
  });
  await d.audit.record(tx, {
    actor: { kind: 'system' },
    action: 'refund.failed',
    target: rq.id,
    reason: 'over_refund_remote',
    detail: {
      unit_id: unit.id,
      requested_minor: rq.amount_minor,
      remote_remaining_minor: f.remaining_minor,
      in_flight_minor: f.in_flight_minor,
    },
  });
}

/**
 * Our own refunds of the unit that PayPal's read may not show yet: sent, unknown, pending,
 * unresolved or completed, whose refund id is missing or not in the read's list. They are
 * subtracted from what the read says is left. A refund whose answer was lost has no id, so it is
 * subtracted even when the read already lists it (the safe side: it can only close a request).
 *
 * Known and accepted (CO-4 review item d): a lost-but-landed answer is therefore subtracted twice,
 * once because PayPal lists the refund and once because our request has no id, so one legitimate
 * request may be closed over_refund_remote. The operator asks again once the lost request is settled
 * (resend, or a human for `unresolved`). Closing is the safe side: money is never refunded twice.
 * Pinned by a test ("a lost-but-landed answer is subtracted twice").
 */
async function inFlightMinor(
  tx: SqlExecutor,
  unit_id: Id,
  except: Id,
  listed: ReadonlySet<string>,
): Promise<number> {
  const rows = await tx.query<{ amount_minor: number; refund_id: string | null }>(
    `SELECT amount_minor, refund_id FROM refund_requests
      WHERE unit_id = $1 AND id <> $2 AND state IN ('sent', 'unknown', 'pending', 'unresolved', 'completed')`,
    [unit_id, except],
  );
  return rows.rows
    .filter((r) => r.refund_id === null || !listed.has(r.refund_id))
    .reduce((sum, r) => sum + Number(r.amount_minor), 0);
}

/**
 * The check before the first send, made outside any lock because it reads PayPal. `done` is set
 * when nothing may be sent: `unavailable` leaves the request `requested` with a due operation (the
 * due-work pass asks again); `over` closes it. Otherwise `gate` is the read that let it through
 * (null when the request is not `requested`: the prepare transaction answers). The prepare
 * transaction repeats the comparison under the order lock, with our refunds in flight subtracted
 * (F1): two executions at once, or a lost answer that never landed, cannot both pass.
 */
async function checkRemote(
  d: PaymentsDeps,
  request_id: Id,
): Promise<{ done: Executed } | { done: null; gate: Gate | null }> {
  // Read outside any transaction: the port may use the database itself.
  const peek = await loadRequest(d.db, request_id);
  if (peek === null || peek.state !== 'requested') return { done: null, gate: null }; // the transaction below answers
  const remote = await remoteRemaining(d, peek);
  if (remote.kind === 'ok' && remote.remaining_minor >= peek.amount_minor) {
    return { done: null, gate: remote };
  }
  const done = await d.db.transaction(async (tx): Promise<Executed> => {
    // Lock order: the order and its operations, then the unit, then the request.
    await lockOrderOfUnit(tx, peek.unit_id);
    const unit = await loadUnitFacts(tx, peek.unit_id, true);
    if (unit === null) return err({ code: 'rejected' });
    const rq = await loadRequest(tx, request_id, true);
    if (rq === null) return err({ code: 'rejected' });
    if (rq.state !== 'requested') return answerOf(rq.state);
    const at = d.clock.now().toISOString();
    if (remote.kind === 'unavailable') {
      const key = requestIdFor('refund', rq.id);
      const op = await loadOperationByRequestId(tx, key, { lock: true });
      if (op === null) {
        await tx.query(
          `INSERT INTO operations (id, order_id, unit_id, kind, state, attempt, request_id, first_sent_at,
             idem_safe_until, lease_until, next_retry_at, reconcile_until, failure_reason, created_at, updated_at)
           VALUES ($1, $2, $3, 'refund', 'unknown', 1, $4, NULL, NULL, NULL, $5, $6, NULL, $7, $7)`,
          [
            d.ids.next('opr'),
            unit.order_id,
            unit.id,
            key,
            addMs(at, backoffMs(d.config, 1)),
            addMs(at, d.config.reconcile_window_ms),
            at,
          ],
        );
      }
      return err({ code: 'unknown' });
    }
    await closeOver(tx, d, unit, rq, {
      remaining_minor: remote.remaining_minor,
      captured_minor: remote.captured_minor,
      in_flight_minor: await inFlightMinor(tx, unit.id, rq.id, remote.listed),
    });
    return ok({ status: 'FAILED' as const });
  });
  return { done };
}

export async function executeRefund(
  d: PaymentsDeps,
  i: { refund_request_id: Id; scenario?: string | null },
): Promise<Executed> {
  // Read outside any transaction: the port may use the database itself.
  if (!(await d.switches.isOn('refunds_enabled'))) return err({ code: 'rejected' });
  // BU-4: never send an amount PayPal does not hold, and never send blind.
  const checked = await checkRemote(d, i.refund_request_id);
  if (checked.done !== null) return checked.done;
  const gate = checked.gate;
  type Prepared =
    { kind: 'done'; result: Executed } | { kind: 'send'; rq: RequestRow; key: string };
  const prepared = await d.db.transaction(async (tx): Promise<Prepared> => {
    // Lock order: the order and its operations, then the unit, then the request.
    const first = await loadRequest(tx, i.refund_request_id);
    if (first === null) return { kind: 'done', result: err({ code: 'rejected' }) };
    await lockOrderOfUnit(tx, first.unit_id);
    const unit = await loadUnitFacts(tx, first.unit_id, true);
    if (unit === null) return { kind: 'done', result: err({ code: 'rejected' }) };
    const rq = await loadRequest(tx, i.refund_request_id, true);
    if (rq === null) return { kind: 'done', result: err({ code: 'rejected' }) };
    if (rq.state !== 'requested') return { kind: 'done', result: answerOf(rq.state) };
    if (gate !== null) {
      // Under the order lock: what the read said, less our own refunds it may not show yet.
      const inFlight = await inFlightMinor(tx, unit.id, rq.id, gate.listed);
      if (gate.remaining_minor - inFlight < rq.amount_minor) {
        await closeOver(tx, d, unit, rq, {
          remaining_minor: gate.remaining_minor,
          captured_minor: gate.captured_minor,
          in_flight_minor: inFlight,
        });
        return { kind: 'done', result: ok({ status: 'FAILED' as const }) };
      }
    }
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
    // A send that was put off (BU-4) already has its operation: it becomes the sent one.
    await tx.query(
      `UPDATE operations SET state = 'sent', attempt = 1, first_sent_at = $2, idem_safe_until = $3, lease_until = $4,
         next_retry_at = NULL, reconcile_until = NULL, updated_at = $2
       WHERE request_id = $1 AND state = 'unknown' AND first_sent_at IS NULL`,
      [key, at, addMs(at, d.config.idem_safe_window_ms), addMs(at, d.config.operation_lease_ms)],
    );
    await tx.query("UPDATE refund_requests SET state = 'sent', updated_at = $2 WHERE id = $1", [
      rq.id,
      at,
    ]);
    return { kind: 'send', rq, key };
  });
  if (prepared.kind === 'done') return prepared.result;

  // Outside any transaction (P14). A crash here leaves the operation `sent`; recovery reads.
  let raw: unknown;
  try {
    raw = await d.paypal.refundCapture({
      capture_id: prepared.rq.capture_id,
      request_id: prepared.key,
      amount: { currency: prepared.rq.currency, minor: prepared.rq.amount_minor },
      note: prepared.rq.reason,
    });
  } finally {
    // Whatever happened, the order at PayPal may have changed: the next check reads again.
    recentReads.delete(d.paypal);
  }
  const parsed = RefundResSchema.safeParse(raw);
  return recordCall(d, prepared.rq.id, parsed.success ? parsed.data : { kind: 'timeout' });
}

/** Records the answer of a refund call (first send or resend) and, when PayPal accepted it, reads it back. */
async function recordCall(d: PaymentsDeps, request_id: Id, res: RefundRes): Promise<Executed> {
  const outcome = await d.db.transaction(async (tx) => {
    const at = d.clock.now().toISOString();
    // Lock order: the order and its operations, then the request.
    const first = await loadRequest(tx, request_id);
    if (first === null) throw new Error(`refund request ${request_id} vanished`);
    const unit = await loadUnitFacts(tx, first.unit_id, false);
    if (unit === null) throw new Error(`unit of refund request ${request_id} vanished`);
    await lockOrderRows(tx, unit.order_id);
    const rq = await loadRequest(tx, request_id, true);
    if (rq === null) throw new Error(`refund request ${request_id} vanished`);
    // M-1: the operation of THIS request, by its own key, never "the refund operation of the order".
    const op = await loadOperationByRequestId(tx, requestIdFor('refund', rq.id), { lock: true });
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
      // H-2: `pending` and the operation that reads it back are stored together. If the read
      // below never happens (a throw, a dead process), the due-work pass finishes the job.
      await ensureRefundReadbackOp(tx, d, rq.id, unit.order_id, op.first_sent_at ?? at, at);
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
 * The read-back operation of one refund request (`umsRB-<request id>`, state unknown, polled with
 * the backoff schedule until 24 h after the refund call). Created in the transaction that stores
 * `pending`; reset to unknown when it exists in another state (startup recovery, a replay).
 */
export async function ensureRefundReadbackOp(
  tx: SqlExecutor,
  d: Pick<CoreDeps, 'clock' | 'ids' | 'config'>,
  refund_request_id: Id,
  order_id: Id,
  anchor: string,
  at: string,
): Promise<void> {
  const key = refundReadbackKeyFor(refund_request_id);
  const until = addMs(anchor, d.config.reconcile_window_ms);
  const existing = await loadOperationByRequestId(tx, key, { lock: true });
  if (existing === null) {
    await insertOperation(tx, {
      id: d.ids.next('opr'),
      order_id,
      kind: 'refund_readback',
      state: 'unknown',
      request_id: key,
      lease_until: null,
      reconcile_until: until,
      next_retry_at: addMs(at, backoffMs(d.config, 1)),
      at,
    });
  } else if (existing.state !== 'unknown' && existing.state !== 'sent') {
    await tx.query(
      `UPDATE operations SET state = 'unknown', failure_reason = NULL, lease_until = NULL, reconcile_until = $2, next_retry_at = $3, updated_at = $4 WHERE id = $1`,
      [existing.id, until, addMs(at, backoffMs(d.config, 1)), at],
    );
  }
}

/**
 * GET refund and a read of the order. Nothing is booked unless GET refund says COMPLETED and the
 * order read shows at least that much refunded; the amount booked is GET refund's. Anything else
 * leaves a refund_readback operation polling.
 */
export async function readBack(d: PaymentsDeps, request_id: Id): Promise<Executed> {
  return (await readBackChecked(d, request_id)).result;
}

/**
 * readBack, and whether a read it needed was BLOCKED (call budget spent, kill switch, no approval,
 * connect off). A blocked read is no evidence: the caller must not close a request at the end of the
 * window on it, only try again later.
 */
async function readBackChecked(
  d: PaymentsDeps,
  request_id: Id,
): Promise<{ result: Executed; blocked: boolean }> {
  const rq = await loadRequest(d.db, request_id);
  if (rq === null || rq.refund_id === null)
    return { result: err({ code: 'unknown' }), blocked: false };
  const unit = await loadUnitFacts(d.db, rq.unit_id, false);
  if (unit === null) return { result: err({ code: 'unknown' }), blocked: false };
  const got = await d.paypal.getRefund(rq.refund_id);
  let blocked = got.kind === 'blocked';
  let status: RefundStatus | null = null;
  let amount: Money | null = null;
  if (got.kind === 'refund') {
    status = got.status;
    amount = got.amount;
  }
  // What the order read says about the capture: its STATUS decides; the refunded total is advisory
  // (PayPal may report 0 for a refunded capture) and is used only when it is there.
  let capStatus: string | null = null;
  let capRefunded = 0;
  if (status === 'COMPLETED') {
    const provider = await providerOrderIdOfUnit(d.db, rq.unit_id);
    const read: OrderRead | null = provider === null ? null : await d.paypal.getOrder(provider);
    if (read !== null && read.kind === 'blocked') blocked = true;
    if (read !== null && read.kind === 'order') {
      const cap = read.units.find((u) => u.capture?.capture_id === rq.capture_id)?.capture;
      if (cap !== undefined && cap !== null) {
        capStatus = cap.status;
        capRefunded = cap.refunded_minor;
      }
    }
  }
  const result = await d.db.transaction(async (tx): Promise<Executed> => {
    const at = d.clock.now().toISOString();
    // Lock order: the order and its operations, then the unit, then the request.
    await lockOrderRows(tx, unit.order_id);
    const fresh = await loadUnitFacts(tx, rq.unit_id, true);
    if (fresh === null) throw new Error(`unit of refund request ${request_id} vanished`);
    const row = await loadRequest(tx, request_id, true);
    if (row === null) throw new Error(`refund request ${request_id} vanished`);
    // Someone else finished it first.
    if (row.state !== 'pending') return answerOf(row.state);
    const op = await loadOperationByRequestId(tx, refundReadbackKeyFor(row.id), { lock: true });
    const settle = async (): Promise<void> => {
      if (op !== null && op.state === 'unknown') {
        await tx.query(
          `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1`,
          [op.id, at],
        );
      }
    };
    const shown =
      status === 'COMPLETED' &&
      amount !== null &&
      capStatus !== null &&
      REFUNDED_STATUS.has(capStatus) &&
      (capRefunded === 0 || capRefunded >= fresh.refunded_minor + amount.minor);
    if (shown && amount !== null) {
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
    const sent = await loadOperationByRequestId(tx, requestIdFor('refund', row.id));
    await ensureRefundReadbackOp(tx, d, row.id, fresh.order_id, sent?.first_sent_at ?? at, at);
    return ok({ status: 'PENDING' as const });
  });
  return { result, blocked };
}

/** What the ledger says is refunded for a unit: the sum of its refund entries (D-019). */
async function ledgerRefunded(tx: SqlExecutor, unit_id: Id): Promise<number> {
  const r = (
    await tx.query<{ n: string | number }>(
      "SELECT COALESCE(sum(amount_minor), 0) AS n FROM ledger_entries WHERE unit_id = $1 AND kind = 'refund'",
      [unit_id],
    )
  ).rows[0];
  return Number(r?.n ?? 0);
}

type Booked = 'booked' | 'replay' | 'refused';

/**
 * Appends one refund to the ledger by its refund id and sets the unit from the SUMS (D-019): the
 * ledger total below the captured amount is `partially_refunded`, equal is `refunded`. The caller
 * ends access for a full refund and issues the receipt (once per read, however many refunds it
 * books). `refused` means the refund did not fit the unit: an alert is raised and a human decides.
 */
async function bookEntry(
  tx: SqlExecutor,
  d: CoreDeps,
  unit: UnitFacts,
  refund_id: string,
  amount: Money,
): Promise<{ result: Booked; full: boolean }> {
  // Lock order (D-020): the items of the unit (rank 5) before the ledger (rank 6). A full refund
  // updates the items after the entry is appended, so they are locked first.
  await tx.query('SELECT id FROM entitlements WHERE unit_id = $1 ORDER BY article_id FOR UPDATE', [
    unit.id,
  ]);
  const refunded = await ledgerRefunded(tx, unit.id);
  if (
    unit.capture_id === null ||
    !BOOKABLE.has(unit.status) ||
    amount.currency !== unit.currency ||
    amount.minor <= 0 ||
    amount.minor > unit.amount_minor - refunded
  ) {
    await raiseOpsAlert(tx, d, {
      kind: 'refund_unresolved',
      order_id: unit.order_id,
      unit_id: unit.id,
      reason: `cannot_book_${refund_id}`,
      detail: { amount_minor: amount.minor, status: unit.status },
    });
    return { result: 'refused', full: false };
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
    return { result: 'refused', full: false };
  }
  if (!added.ok) return { result: 'replay', full: false }; // booked before: a replay changes nothing
  const total = refunded + amount.minor;
  const full = total >= unit.amount_minor;
  await tx.query(
    'UPDATE order_units SET refunded_minor = $2, status = $3, updated_at = $4 WHERE id = $1',
    [unit.id, total, full ? 'refunded' : 'partially_refunded', d.clock.now().toISOString()],
  );
  if (d.outbox !== undefined) {
    // API-C: once per booked refund, partial or full. A replay returned above and writes nothing.
    await d.outbox.append(tx, {
      type: 'refund.completed',
      payload: {
        refund_id,
        order_id: unit.order_id,
        unit_id: unit.id,
        publisher_id: unit.publisher_id,
        amount,
        completed_at: d.clock.now().toISOString(),
      },
    });
  }
  return { result: 'booked', full };
}

/** After booking: a fully refunded unit ends access; the receipt gets its next version. */
async function afterBooking(
  tx: SqlExecutor,
  d: CoreDeps,
  unit: Pick<UnitFacts, 'id' | 'order_id'>,
  full: boolean,
): Promise<void> {
  // Only a full refund moves a money event. A partial refund is a unit-level price adjustment: it
  // never revokes an item (ASM-61), and a refund that is still PENDING never gets here at all.
  if (full) await refundEntitlements(tx, d, unit.id);
  await issueReceiptIfChanged(tx, d, { order_id: unit.order_id });
}

// Books the refund of one request by its id. Returns false when the refund could not be booked.
async function book(
  tx: SqlExecutor,
  d: CoreDeps,
  unit: UnitFacts,
  refund_id: string,
  amount: Money,
): Promise<boolean> {
  const r = await bookEntry(tx, d, unit, refund_id, amount);
  if (r.result === 'refused') return false;
  if (r.result === 'booked') await afterBooking(tx, d, unit, r.full);
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
  if (rq.state === 'cancelled' && rq.refund_id === null) return; // withdrawn by an operator, never sent
  if (op.kind === 'refund' && rq.state === 'requested' && rq.refund_id === null) {
    // BU-4: the first send was put off because PayPal's remaining amount could not be read.
    if (ended) {
      // CO-4: the 24 h window is over. A refund that was never sent is not sent late (the operator
      // asked a day ago, the books may have moved); it is closed unsent and a human is told.
      await closeUnsent(d, op, request_id);
      return;
    }
    // Nothing was ever sent, so this is the whole first-send path again, check included.
    await executeRefund(d, { refund_request_id: request_id });
    return;
  }
  if (op.kind === 'refund_readback' || rq.refund_id !== null) {
    const r = await readBackChecked(d, request_id);
    if (r.result.ok && r.result.value.status !== 'PENDING') return;
    // A blocked read is no evidence: try again later, whatever the window says.
    if (ended && !r.blocked) await closeRefundUnknown(d, op, true);
    return;
  }
  // The resend below is NOT checked against PayPal's remaining amount, on purpose: it carries the
  // same PayPal-Request-Id and the same amount as the first call, so PayPal answers it from the
  // first call's result and never refunds twice. A check here would see the refund the first call
  // made (it may have landed) as money already gone and wrongly close a refund that exists.
  // Pinned by a test ("the resend of a lost answer is not checked").
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
 * The 24 h window of a put-off send ended and PayPal's remaining amount was never readable. The
 * refund was never sent, so the request is provably not a refund: it is closed `failed`, its
 * reservation is freed and a human is told.
 */
async function closeUnsent(d: PaymentsDeps, op: RefundOp, request_id: Id): Promise<void> {
  const rq = await loadRequest(d.db, request_id);
  if (rq === null || rq.state !== 'requested') return;
  const unit = await loadUnitFacts(d.db, rq.unit_id, false);
  if (unit === null) return;
  await d.db.transaction(async (tx) => {
    const at = d.clock.now().toISOString();
    await lockOrderRows(tx, unit.order_id);
    const closed = await tx.query(
      "UPDATE refund_requests SET state = 'failed', updated_at = $2 WHERE id = $1 AND state = 'requested' RETURNING id",
      [rq.id, at],
    );
    if (closed.rows.length === 0) return;
    await tx.query(
      `UPDATE operations SET state = 'failed', failure_reason = 'window_expired', lease_until = NULL, next_retry_at = NULL, updated_at = $2
       WHERE id = $1 AND state = 'unknown'`,
      [op.id, at],
    );
    await raiseOpsAlert(tx, d, {
      kind: 'refund_failed',
      order_id: unit.order_id,
      unit_id: unit.id,
      reason: `refund_not_sent_${rq.id}`,
      detail: { refund_request_id: rq.id },
    });
  });
}

/**
 * The 5 h key limit passed, or the 24 h window ended, with the outcome of a refund call unknown.
 * One read of the order. The request is `failed` (and its reserved amount freed) only when that
 * read PROVES PayPal did not refund: no refund id was ever returned and the capture shows no
 * refund. In every other case PayPal may have refunded: the request becomes `unresolved`, keeps
 * its reservation, and a human is told (M-2). The operation is closed either way; no resend.
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
  // null: not proven. 0: the read shows no refund beyond what is booked. > 0: a refund exists.
  let excess: number | null = null;
  let readOk = false; // the order read showed this capture: what it shows is evidence
  if (rq.refund_id === null) {
    const provider = await providerOrderIdOfUnit(d.db, rq.unit_id);
    if (provider !== null) {
      const read = await d.paypal.getOrder(provider);
      // A blocked read (call budget spent, kill switch, no approval, connect off) is no evidence at
      // all, not even "unreadable": the call never reached PayPal. Never close on it, window or not.
      if (read.kind === 'blocked') return false;
      if (read.kind === 'order') {
        const cap = read.units.find((u) => u.capture?.capture_id === rq.capture_id)?.capture;
        if (cap !== undefined && cap !== null) {
          readOk = true;
          if (cap.refunded_minor > 0) excess = cap.refunded_minor - unit.refunded_minor;
          else if (!REFUNDED_STATUS.has(cap.status)) excess = 0;
          // else: refunded at PayPal, amount not reported: not proven either way.
        }
      }
    }
    // The read failed: try again until the window ends.
    if (!readOk && !windowEnded) return false;
  }
  await d.db.transaction(async (tx) => {
    const at = d.clock.now().toISOString();
    await lockOrderRows(tx, unit.order_id);
    await tx.query(
      `UPDATE operations SET state = 'failed', failure_reason = 'window_expired', lease_until = NULL, next_retry_at = NULL, updated_at = $2
       WHERE id = $1 AND state = 'unknown'`,
      [op.id, at],
    );
    // A request that was still waiting on this operation is settled with it.
    const proven = excess === 0;
    await tx.query(
      "UPDATE refund_requests SET state = $3, updated_at = $2 WHERE id = $1 AND state IN ('unknown', 'pending')",
      [rq.id, at, proven ? 'failed' : 'unresolved'],
    );
    if (!proven) {
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
  // Lock order: the order of the capture and its operations first, then the unit.
  const owner = (
    await tx.query<{ order_id: string }>('SELECT order_id FROM order_units WHERE capture_id = $1', [
      i.capture_id,
    ])
  ).rows[0];
  if (owner === undefined) return { found: false, changed: false };
  await lockOrderRows(tx, owner.order_id);
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

const REFUND_STATUSES: ReadonlySet<string> = new Set(RefundStatusSchema.options);

/**
 * Refund ids are compared ignoring case and surrounding whitespace, for MATCHING only (a stored id
 * is always the one listed or returned, never this form). ASM-53 still needs the real ids to be
 * byte-identical; this only keeps a case change from booking one refund twice.
 */
const idKey = (id: string): string => id.trim().toLowerCase();

/**
 * A refund list that does not add up cannot be trusted to book anything: the unit is frozen the way
 * a mismatch freezes a paid order (the order keeps its status and gets `mismatch`, a frozen_order
 * alert names the unit and the reason, and a recovery case opens from it). Nothing is booked, no
 * receipt version is issued, no access changes. The same list read again raises nothing new.
 */
async function freezeOnList(
  tx: SqlExecutor,
  d: CoreDeps,
  unit: Pick<UnitFacts, 'id' | 'order_id'>,
  reason: string,
): Promise<void> {
  await tx.query('UPDATE orders SET mismatch = true, updated_at = $2 WHERE id = $1', [
    unit.order_id,
    d.clock.now().toISOString(),
  ]);
  await raiseOpsAlert(tx, d, {
    kind: 'frozen_order',
    order_id: unit.order_id,
    unit_id: unit.id,
    reason,
    detail: { source: 'refund_list' },
  });
}

/**
 * Books the refunds a read lists for a unit that UnitMarket has no refund request for (a refund made
 * at the PayPal dashboard, ASM-53): each COMPLETED refund not yet in the ledger becomes one ledger
 * entry keyed by its refund id, with the listed amount; the unit status follows the sums; one new
 * receipt version is issued for the read. PENDING, FAILED and CANCELLED refunds book nothing and
 * move no money event. A list that does not add up (an unknown status, another currency, a bad
 * amount, one id twice with two answers, a sum above the captured amount) books nothing and freezes
 * the unit (freezeOnList). Refunds of ours (matched by refund id) are left to their read-back.
 */
async function bookListed(
  tx: SqlExecutor,
  d: CoreDeps,
  unit_id: Id,
  listed: readonly OrderReadRefund[],
): Promise<void> {
  const unit = await loadUnitFacts(tx, unit_id, false);
  if (unit === null || unit.capture_id === null) return;

  // 1. The list must be readable as a whole.
  const byId = new Map<string, OrderReadRefund>();
  for (const x of listed) {
    if (!REFUND_STATUSES.has(x.status))
      return freezeOnList(tx, d, unit, `refund_list_status_${x.refund_id}`);
    if (x.amount.currency !== unit.currency) {
      return freezeOnList(tx, d, unit, `refund_list_currency_${x.refund_id}`);
    }
    if (
      x.status === 'COMPLETED' &&
      (!Number.isSafeInteger(x.amount.minor) || x.amount.minor <= 0)
    ) {
      return freezeOnList(tx, d, unit, `refund_list_amount_${x.refund_id}`);
    }
    const seen = byId.get(idKey(x.refund_id));
    if (seen !== undefined) {
      // An id listed twice counts once, when both entries say the same thing.
      if (seen.status !== x.status || seen.amount.minor !== x.amount.minor) {
        return freezeOnList(tx, d, unit, `refund_list_conflict_${seen.refund_id}`);
      }
      continue;
    }
    byId.set(idKey(x.refund_id), x);
  }
  const completed = [...byId.values()].filter((x) => x.status === 'COMPLETED');
  const listedTotal = completed.reduce((sum, x) => sum + x.amount.minor, 0);
  if (listedTotal > unit.amount_minor) {
    return freezeOnList(tx, d, unit, 'refund_list_exceeds_capture');
  }

  // 2. Which of them are new to us?
  const ours = new Map<string, string>();
  for (const r of (
    await tx.query<{ refund_id: string; state: string }>(
      'SELECT refund_id, state FROM refund_requests WHERE unit_id = $1 AND refund_id IS NOT NULL',
      [unit.id],
    )
  ).rows) {
    ours.set(idKey(r.refund_id), r.state);
  }
  const booked = new Set(
    (
      await tx.query<{ refund_id: string }>(
        "SELECT refund_id FROM ledger_entries WHERE capture_id = $1 AND kind = 'refund'",
        [unit.capture_id],
      )
    ).rows.map((r) => idKey(r.refund_id)),
  );
  const fresh: OrderReadRefund[] = [];
  for (const x of completed) {
    const state = ours.get(idKey(x.refund_id));
    if (state !== undefined) {
      // Ours: its read-back books it. If our books closed it as not refunded while PayPal lists it
      // COMPLETED, money moved that we think did not: a human decides, nothing is booked here.
      if (state === 'failed' || state === 'cancelled' || state === 'rejected') {
        await raiseOpsAlert(tx, d, {
          kind: 'refund_unbooked',
          order_id: unit.order_id,
          unit_id: unit.id,
          reason: `listed_completed_after_${state}_${x.refund_id}`,
          detail: { shown_minor: x.amount.minor, request_state: state },
        });
      }
      continue;
    }
    if (!booked.has(idKey(x.refund_id))) fresh.push(x);
  }
  if (fresh.length === 0) return;

  // 3. A request of ours whose answer was lost has no refund id: one of the listed refunds may be
  // it. Nothing is booked as a dashboard refund until that request is settled (resend or a human).
  const lost = await tx.query(
    `SELECT 1 FROM refund_requests WHERE unit_id = $1 AND refund_id IS NULL
        AND state IN ('sent', 'unknown', 'unresolved') LIMIT 1`,
    [unit.id],
  );
  if (lost.rows.length > 0) {
    // Silence here would leave a refunded buyer with access and nobody told: one alert per listed
    // refund id (the index dedupes a repeat), with the ids and amounts only.
    for (const x of fresh) {
      await raiseOpsAlert(tx, d, {
        kind: 'refund_unbooked',
        order_id: unit.order_id,
        unit_id: unit.id,
        reason: `listed_held_${x.refund_id}`,
        detail: { shown_minor: x.amount.minor, held_by: 'request_without_refund_id' },
      });
    }
    return;
  }

  // 4. The sums must still fit the captured amount, and the unit must be one we can book on.
  const already = await ledgerRefunded(tx, unit.id);
  const freshTotal = fresh.reduce((sum, x) => sum + x.amount.minor, 0);
  if (already + freshTotal > unit.amount_minor) {
    return freezeOnList(tx, d, unit, 'refund_list_exceeds_capture');
  }
  if (!BOOKABLE.has(unit.status)) {
    await raiseOpsAlert(tx, d, {
      kind: 'refund_unresolved',
      order_id: unit.order_id,
      unit_id: unit.id,
      reason: `listed_refund_on_${unit.status}_${fresh[0]!.refund_id}`,
      detail: { shown_minor: freshTotal, status: unit.status },
    });
    return;
  }

  // 5. Book them, then end access once if the sums say so, and issue one receipt version.
  let any = false;
  let full = false;
  let current = unit;
  for (const x of fresh) {
    const r = await bookEntry(tx, d, current, x.refund_id, x.amount);
    if (r.result === 'booked') {
      any = true;
      full = full || r.full;
      current = { ...current, status: r.full ? 'refunded' : 'partially_refunded' };
    }
  }
  if (any) await afterBooking(tx, d, unit, full);
}

type OrderReadOk = Extract<OrderRead, { kind: 'order' }>;

/**
 * After a read was applied: a verified capture that PayPal now shows as declined or failed is a
 * suspected reversal. Refunds are read from the order's own refund list when it has one (CO-4,
 * ASM-53): each COMPLETED refund that matches no request of ours and is not in the ledger is booked
 * by its refund id (bookListed). Without a usable list (none, or an empty one beside a capture that
 * reads refunded) the old rule stays: a verified capture that PayPal shows as refunded (status
 * PARTIALLY_REFUNDED or REFUNDED) for more than UnitMarket booked is alerted (refund_unbooked), and
 * a full one ends the access, because the money went back. The capture STATUS decides first; the
 * refunded total is advisory (PayPal may report 0) and is used only when it is there (M-2).
 */
export async function observeReadback(
  tx: SqlExecutor,
  d: CoreDeps,
  read: OrderReadOk,
): Promise<void> {
  for (const ru of read.units) {
    const cap = ru.capture;
    if (cap === null) continue;
    const owner = (
      await tx.query<{ order_id: string }>(
        'SELECT order_id FROM order_units WHERE capture_id = $1 AND captured_verified_at IS NOT NULL',
        [cap.capture_id],
      )
    ).rows[0];
    if (owner === undefined) continue;
    await lockOrderRows(tx, owner.order_id); // lock order: the order first, then the unit
    const unit = (
      await tx.query<{
        id: string;
        order_id: string;
        status: string;
        refunded_minor: number;
        amount_minor: number;
      }>(
        `SELECT id, order_id, status, refunded_minor, amount_minor FROM order_units
          WHERE capture_id = $1 AND captured_verified_at IS NOT NULL FOR UPDATE`,
        [cap.capture_id],
      )
    ).rows[0];
    if (unit === undefined) continue;
    if (cap.status === 'DECLINED' || cap.status === 'FAILED') {
      await suspectReversalTx(tx, d, { capture_id: cap.capture_id, source: 'read' });
      continue;
    }
    // The order lists its refunds (BU-4, ASM-53): book from the list. An empty list beside a capture
    // that reads refunded is no list at all (the sandbox may not return it): the old path below.
    const list = ru.refunds;
    if (list !== undefined && !(list.length === 0 && REFUNDED_STATUS.has(cap.status))) {
      await bookListed(tx, d, unit.id, list);
      continue;
    }
    if (!REFUNDED_STATUS.has(cap.status)) continue;
    const booked = Number(unit.refunded_minor);
    const full = cap.status === 'REFUNDED';
    // Is there a refund UnitMarket has not booked? With a reported total, compare it. Without one,
    // a full refund is unbooked unless the unit is already fully refunded, and a partial one is
    // unbooked while nothing at all is booked.
    const unbooked =
      cap.refunded_minor > 0
        ? cap.refunded_minor > booked
        : full
          ? unit.status !== 'refunded'
          : booked === 0;
    if (!unbooked) continue;
    const open = await tx.query(
      `SELECT 1 FROM refund_requests WHERE unit_id = $1 AND state IN ${OPEN} LIMIT 1`,
      [unit.id],
    );
    if (open.rows.length > 0) continue; // our own refund, still being read back
    await raiseOpsAlert(tx, d, {
      kind: 'refund_unbooked',
      order_id: unit.order_id,
      unit_id: unit.id,
      reason: `refund_unbooked_${cap.status.toLowerCase()}_${cap.refunded_minor}`,
      detail: { shown_minor: cap.refunded_minor, booked_minor: booked, status: cap.status },
    });
    if (full && BOOKABLE.has(unit.status)) {
      await tx.query("UPDATE order_units SET status = 'refunded', updated_at = $2 WHERE id = $1", [
        unit.id,
        d.clock.now().toISOString(),
      ]);
      await refundEntitlements(tx, d, unit.id);
    }
  }
}
