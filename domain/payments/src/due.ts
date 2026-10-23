// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/due.ts (P10, P11) at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05b.
// The scheduled work of payments. Product code never schedules: the job loop asks `nextDueAt` when
// to wake and calls `runDue` to do what is due. Every unknown operation is read first, polled on
// the backoff schedule (30 s, 2 min, 10 min, 1 h, 1 h ...) until its 24 h window ends, then closed
// with one alert for a human; money is never failed by absence and never charged again. Abandoned
// checkouts (P17) and the re-read of paid orders for 7 days (hourly; `reread_paid_every_ms` slows
// it in sandbox mode, BU-5) run from the same pass. A pass can be limited to the money work
// (`allow: 'money_only'`) when the job loop has spent its polling allowance of the day's calls.
import { applyMoneyEvent } from '@umsbx/entitlements';
import type {
  DomainConfig,
  Id,
  IsoUtc,
  OrderRead,
  PaymentsDeps,
  SqlExecutor,
} from '@umsbx/contracts';
import { declineUnits, ensureReadbackOp, readApplyGates } from './apply';
import { onBuyerReturn } from './return';
import { readAndApply, resendCreate, retryCapture, TERMINAL } from './reconcile';
import { raiseOpsAlert, resumeRefund } from './refunds';
import type { RefundOp } from './refunds';
import { readbackKeyFor } from './keys';
import { addMs, insertOperation, isoOf, loadOperation, loadOrder, lockOrderRows } from './store';
import type { OperationRow, OrderRow } from './store';

const earlier = (a: string, b: string): string => (Date.parse(a) <= Date.parse(b) ? a : b);

/**
 * The next poll of an unknown operation: the schedule is counted from `anchor` (the first send),
 * +30 s, +2 min, +10 min, +1 h, +1 h ... cumulatively, and the next poll is the first scheduled
 * time after `now`, so a late run does not stack delays. Never later than `until`.
 */
export function nextPollAt(
  config: Pick<DomainConfig, 'reconcile_backoff_ms'>,
  anchor: string,
  now: string,
  until: string,
): string {
  const list = config.reconcile_backoff_ms;
  const start = Date.parse(anchor);
  const at = Date.parse(now);
  let offset = 0;
  for (let step = 0; ; step += 1) {
    offset += Math.max(1, list[Math.min(step, list.length - 1)] ?? 30_000);
    if (start + offset > at) return earlier(new Date(start + offset).toISOString(), until);
  }
}

// Paid orders watched for 7 days: next re-read `every` after the last one (the readback operation's
// updated_at is the marker) or after the capture was verified. `every` is a whole number of
// milliseconds built by `rereadMs`, never text from outside.
const DEFAULT_REREAD_MS = 3_600_000;
const MAX_REREAD_MS = 86_400_000;
const rereadMs = (c: { reread_paid_every_ms?: number | undefined }): number => {
  const v = c.reread_paid_every_ms;
  // Above 24 h would end the 7 day watch; such a value is a mistake, so the cadence stays hourly.
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_REREAD_MS
    ? v
    : DEFAULT_REREAD_MS;
};
const paidWatch = (every: number): string => `
  SELECT o.id, v.verified_at, m.last_at,
         GREATEST(COALESCE(m.last_at, v.verified_at), v.verified_at) + interval '${every} milliseconds' AS next_at
    FROM orders o
    JOIN LATERAL (SELECT max(u.captured_verified_at) AS verified_at FROM order_units u WHERE u.order_id = o.id) v
      ON v.verified_at IS NOT NULL
    LEFT JOIN LATERAL (SELECT max(p.updated_at) AS last_at FROM operations p WHERE p.order_id = o.id AND p.kind = 'readback') m
      ON true
   WHERE o.status IN ('paid', 'paid_partial')
     AND NOT EXISTS (SELECT 1 FROM operations p WHERE p.order_id = o.id AND p.state = 'unknown'
                       AND p.kind IN ('create', 'capture', 'readback'))`;
// Orders that never got to the buyer: nothing was sent, or a create is still being settled elsewhere.
const NOT_SENT = `NOT EXISTS (SELECT 1 FROM operations p WHERE p.order_id = o.id AND p.kind = 'create' AND p.state IN ('sent', 'unknown'))`;

export async function nextDueAt(
  db: SqlExecutor,
  config: Pick<DomainConfig, 'abandoned_checkout_ms'> &
    Partial<Pick<DomainConfig, 'reread_paid_every_ms'>> = { abandoned_checkout_ms: 86_400_000 },
): Promise<IsoUtc | null> {
  const found = await db.query<Record<string, unknown>>(
    `SELECT
       (SELECT min(next_retry_at) FROM operations WHERE state = 'unknown') AS retry_at,
       (SELECT min(lease_until) FROM operations WHERE state = 'sent') AS lease_at,
       (SELECT min(o.created_at) FROM orders o WHERE o.status = 'awaiting_buyer'
           OR (o.status = 'created' AND ${NOT_SENT})) AS waiting_at,
       (SELECT min(w.next_at) FROM (${paidWatch(rereadMs(config))}) w
         WHERE w.next_at < w.verified_at + interval '7 days') AS reread_at`,
  );
  const row = found.rows[0] ?? {};
  const times: string[] = [];
  const retry = isoOf(row['retry_at']);
  if (retry !== null) times.push(retry);
  // A `sent` operation whose lease runs out belongs to a dead process: the pass must be there then.
  const lease = isoOf(row['lease_at']);
  if (lease !== null) times.push(lease);
  const waiting = isoOf(row['waiting_at']);
  if (waiting !== null) times.push(addMs(waiting, config.abandoned_checkout_ms));
  const reread = isoOf(row['reread_at']);
  if (reread !== null) times.push(reread);
  return times.reduce<string | null>((first, t) => (first === null ? t : earlier(first, t)), null);
}

// ---------------------------------------------------------------------------------------------

interface DueOp extends OperationRow {
  created_at: string;
  failure_reason: string | null;
}
const toDueOp = (r: Record<string, unknown>): DueOp => ({
  id: r['id'] as string,
  order_id: r['order_id'] as string,
  kind: r['kind'] as OperationRow['kind'],
  state: r['state'] as OperationRow['state'],
  attempt: Number(r['attempt']),
  request_id: r['request_id'] as string,
  first_sent_at: isoOf(r['first_sent_at']),
  idem_safe_until: isoOf(r['idem_safe_until']),
  lease_until: isoOf(r['lease_until']),
  next_retry_at: isoOf(r['next_retry_at']),
  reconcile_until: isoOf(r['reconcile_until']),
  created_at: isoOf(r['created_at']) as string,
  failure_reason: (r['failure_reason'] as string | null) ?? null,
});
const nowIso = (d: Pick<PaymentsDeps, 'clock'>): string => d.clock.now().toISOString();
const ended = (op: Pick<OperationRow, 'reconcile_until'>, at: string): boolean =>
  op.reconcile_until !== null && Date.parse(op.reconcile_until) <= Date.parse(at);

/**
 * An operation that was in flight when its process died becomes unknown, due now, with its
 * 24 h window counted from the first send. A capture's order goes back to unresolved.
 */
export async function markUnknown(
  tx: SqlExecutor,
  d: Pick<PaymentsDeps, 'clock' | 'config'>,
  op: { id: Id; order_id: Id; kind: string; first_sent_at: string | null; request_id: string },
  from: 'sent' | 'prepared',
): Promise<boolean> {
  const at = nowIso(d);
  const until = addMs(op.first_sent_at ?? at, d.config.reconcile_window_ms);
  // Lock order: the order and its operations first (store.ts lockOrderRows).
  await lockOrderRows(tx, op.order_id);
  const moved = await tx.query(
    `UPDATE operations SET state = 'unknown', lease_until = NULL, next_retry_at = $2,
       reconcile_until = COALESCE(reconcile_until, $3), updated_at = $2
     WHERE id = $1 AND state = $4 RETURNING id`,
    [op.id, at, until, from],
  );
  if (moved.rows.length === 0) return false;
  if (op.kind === 'capture') {
    await tx.query(
      `UPDATE orders SET status = 'unresolved', updated_at = $2
       WHERE id = $1 AND status IN ('capture_requested', 'capture_claimed')`,
      [op.order_id, at],
    );
  }
  if (op.kind === 'refund') {
    await tx.query(
      "UPDATE refund_requests SET state = 'unknown', updated_at = $2 WHERE id = $1 AND state = 'sent'",
      [op.request_id.replace(/^umsR-/, ''), at],
    );
  }
  return true;
}

// A `sent` operation whose lease ran out belongs to a process that died (REL-2).
async function sweepStale(d: PaymentsDeps): Promise<void> {
  const at = nowIso(d);
  const stale = await d.db.query<Record<string, unknown>>(
    `SELECT id, order_id, kind, first_sent_at, request_id FROM operations
      WHERE state = 'sent' AND lease_until < $1 ORDER BY created_at, id`,
    [at],
  );
  for (const r of stale.rows) {
    await d.db.transaction((tx) =>
      markUnknown(
        tx,
        d,
        {
          id: r['id'] as string,
          order_id: r['order_id'] as string,
          kind: r['kind'] as string,
          first_sent_at: isoOf(r['first_sent_at']),
          request_id: r['request_id'] as string,
        },
        'sent',
      ),
    );
  }
}

type Counts = { processed: number; still_unknown: number; expired: number; abandoned: number };

// The kinds of operation that decide whether money arrived: reading a capture and the read-back.
const MONEY_KINDS = "('capture', 'readback')";
// What a money_only pass may also pick up: work that closes without sending again. A create whose
// order moved on, or whose 5 h key ran out, is closed with no call; a refund that was sent and whose
// 24 h window ended is closed after one read of the order and never sent again. A put-off refund
// (never sent: no first_sent_at) is not touched: closing it would send it.
const MONEY_OR_CALL_FREE = `(kind IN ${MONEY_KINDS}
          OR (kind = 'create' AND ((idem_safe_until IS NOT NULL AND idem_safe_until <= $1)
                OR EXISTS (SELECT 1 FROM orders o WHERE o.id = operations.order_id AND o.status <> 'created')))
          OR (kind = 'refund_readback' AND reconcile_until IS NOT NULL AND reconcile_until <= $1)
          OR (kind = 'refund' AND first_sent_at IS NOT NULL AND reconcile_until IS NOT NULL AND reconcile_until <= $1))`;

/**
 * One pass of due work, at most `max_items` items. `allow: 'money_only'` (the job loop's polling
 * allowance is spent) runs unknown capture and read-back operations, plus the closings that need
 * no resend (a create past its key window or whose order moved on, a refund past its 24 h window);
 * no abandonment, no paid re-read, no resend. Any value but 'all' is read as money_only. Within a pass the order
 * is: capture and read-back unknowns, creates, refunds, abandonment, paid re-reads last.
 */
export async function runDue(
  d: PaymentsDeps,
  i: { max_items: number; allow?: 'all' | 'money_only' },
): Promise<Counts> {
  const out: Counts = { processed: 0, still_unknown: 0, expired: 0, abandoned: 0 };
  if (!Number.isInteger(i.max_items) || i.max_items <= 0) return out;
  const moneyOnly = i.allow !== undefined && i.allow !== 'all';
  // Outside any transaction: the port may use the database itself.
  if (!(await d.switches.isOn('paypal_outbound'))) return out;
  await sweepStale(d); // no provider call: a dead process's work becomes unknown, in every mode

  let budget = i.max_items;
  const at = nowIso(d);
  const rows = await d.db.query<Record<string, unknown>>(
    `SELECT * FROM operations WHERE state = 'unknown' AND next_retry_at <= $1
        ${moneyOnly ? `AND ${MONEY_OR_CALL_FREE}` : ''}
      ORDER BY CASE WHEN kind IN ${MONEY_KINDS} THEN 0 WHEN kind = 'create' THEN 1 ELSE 2 END,
               next_retry_at, id LIMIT $2`,
    [at, i.max_items * 2],
  );
  // One item per order for reads (one read serves the capture and the read-back operation), one per
  // operation otherwise; items keep the order of their earliest operation.
  const items = new Map<string, DueOp[]>();
  for (const row of rows.rows) {
    const op = toDueOp(row);
    const key =
      op.kind === 'capture' || op.kind === 'readback' ? `order:${op.order_id}` : `op:${op.id}`;
    items.set(key, [...(items.get(key) ?? []), op]);
  }
  for (const group of items.values()) {
    if (budget <= 0) break;
    const first = group[0] as DueOp;
    const claimed = await claimGroup(d, group);
    if (claimed.length === 0) continue;
    budget -= 1;
    out.processed += 1;
    try {
      if (first.kind === 'create') await processCreate(d, first, out);
      else if (first.kind === 'capture' || first.kind === 'readback') {
        await processRead(d, first.order_id, claimed, out);
      } else await processRefund(d, first, out);
    } catch (e) {
      d.log.log({
        msg: 'payments.due.item_failed',
        level: 'error',
        fields: {
          operation_id: first.id,
          kind: first.kind,
          error: e instanceof Error ? e.message : 'unknown',
        },
      });
      await rescheduleAll(
        d,
        claimed.map((o) => o.id),
      );
    }
  }

  if (moneyOnly) return out;
  budget = await sweepAbandoned(d, budget, out);
  await rereadPaid(d, budget, out);
  return out;
}

// Of several callers, one claims an operation: next_retry_at moves one lease ahead by compare-and-set.
async function claimGroup(d: PaymentsDeps, group: DueOp[]): Promise<DueOp[]> {
  const claimed: DueOp[] = [];
  const at = nowIso(d);
  for (const op of group) {
    const won = await d.db.query(
      `UPDATE operations SET next_retry_at = $2, updated_at = $3
       WHERE id = $1 AND state = 'unknown' AND next_retry_at = $4 RETURNING id`,
      [op.id, addMs(at, d.config.operation_lease_ms), at, op.next_retry_at],
    );
    if (won.rows.length === 1) claimed.push(op);
  }
  return claimed;
}

async function release(d: PaymentsDeps, ops: DueOp[]): Promise<void> {
  for (const op of ops) {
    await d.db.query(
      "UPDATE operations SET next_retry_at = $2 WHERE id = $1 AND state = 'unknown'",
      [op.id, op.next_retry_at],
    );
  }
}

async function loadById(db: SqlExecutor, id: Id): Promise<DueOp | null> {
  const r = (
    await db.query<Record<string, unknown>>('SELECT * FROM operations WHERE id = $1', [id])
  ).rows[0];
  return r === undefined ? null : toDueOp(r);
}

// Next poll for an operation that is still unknown after its step.
async function schedule(d: PaymentsDeps, op: DueOp): Promise<void> {
  const at = nowIso(d);
  const until = op.reconcile_until ?? addMs(op.created_at, d.config.reconcile_window_ms);
  const next = nextPollAt(d.config, op.first_sent_at ?? op.created_at, at, until);
  await d.db.query(
    "UPDATE operations SET next_retry_at = $2, updated_at = $3 WHERE id = $1 AND state = 'unknown'",
    [op.id, next, at],
  );
}
async function rescheduleAll(d: PaymentsDeps, ids: Id[]): Promise<void> {
  for (const id of ids) {
    const op = await loadById(d.db, id);
    if (op !== null && op.state === 'unknown') await schedule(d, op);
  }
}

// ---------------------------------------------------------------------------------------------
// reads: capture and read-back operations of one order

async function processRead(
  d: PaymentsDeps,
  order_id: Id,
  claimed: DueOp[],
  out: Counts,
): Promise<void> {
  const order = await loadOrder(d.db, order_id);
  if (order === null) return;
  if (TERMINAL.has(order.status)) {
    // Frozen, failed or abandoned: a human's or finished. The operations stop here.
    await d.db.query(
      `UPDATE operations SET state = 'failed', failure_reason = $2, lease_until = NULL, next_retry_at = NULL, updated_at = $3
       WHERE order_id = $1 AND kind IN ('capture', 'readback') AND state = 'unknown'`,
      [order_id, order.status === 'frozen' ? 'mismatch' : 'declined', nowIso(d)],
    );
    return;
  }
  // Read first, always (RB-2). At the end of the window this is the last read.
  const outcome = await readAndApply(d, order, 'poll');
  if (outcome.kind === 'paused') {
    await release(d, claimed);
    return;
  }
  if (outcome.kind === 'applied') {
    const again = await maybeRetryCapture(d, order_id, outcome.read);
    if (again === 'paused') {
      await release(d, claimed);
      return;
    }
  }
  await settleRead(d, order_id, claimed, out);
}

// P3: a capture whose answer was lost and a read that shows no capture on any unit, an approved
// order, inside 5 h of the first send, once (1 + max_capture_retries sends), and only when the
// content is deliverable: send again with the same key, then read again.
async function maybeRetryCapture(
  d: PaymentsDeps,
  order_id: Id,
  read: Extract<OrderRead, { kind: 'order' }>,
): Promise<'done' | 'paused'> {
  const cap = await loadOperation(d.db, order_id, 'capture');
  const order = await loadOrder(d.db, order_id);
  if (cap === null || order === null || cap.state !== 'unknown' || order.status !== 'unresolved') {
    return 'done';
  }
  if (read.status !== 'APPROVED' || read.units.some((u) => u.capture !== null)) return 'done';
  if (cap.idem_safe_until === null || Date.parse(nowIso(d)) >= Date.parse(cap.idem_safe_until)) {
    return 'done';
  }
  if (cap.attempt > d.config.max_capture_retries) return 'done';
  if ((await readApplyGates(d, order_id)).not_ready.length > 0) return 'done';
  const sent = await retryCapture(d, order, cap, read.provider_order_id);
  if (sent !== 'claim') return 'done';
  const fresh = await loadOrder(d.db, order_id);
  if (fresh === null) return 'done';
  const second = await readAndApply(d, fresh, 'poll');
  return second.kind === 'paused' ? 'paused' : 'done';
}

// Whatever is still unknown after the read is polled again, or, at the window end, closed.
async function settleRead(
  d: PaymentsDeps,
  order_id: Id,
  claimed: DueOp[],
  out: Counts,
): Promise<void> {
  const unknown = await d.db.query<Record<string, unknown>>(
    `SELECT * FROM operations WHERE order_id = $1 AND kind IN ('capture', 'readback') AND state = 'unknown' ORDER BY created_at, id`,
    [order_id],
  );
  const claimedIds = new Set(claimed.map((o) => o.id));
  let closed = false;
  for (const row of unknown.rows) {
    const op = toDueOp(row);
    if (ended(op, nowIso(d))) {
      await expireRead(d, op);
      closed = true;
    } else {
      await schedule(d, op);
      if (claimedIds.has(op.id)) out.still_unknown += 1;
    }
  }
  if (closed) out.expired += 1;
}

// The 24 h window ended with the evidence still missing or pending: the operation fails with
// window_expired, the items not yet decided become unknown, one alert goes to a human, and the order
// stays as it is. Nothing is failed automatically when a provider order exists, nothing is recharged.
async function expireRead(d: PaymentsDeps, op: DueOp): Promise<void> {
  await d.db.transaction(async (tx) => {
    const at = nowIso(d);
    const order = await lockOrderRows(tx, op.order_id);
    await tx.query(
      `UPDATE operations SET state = 'failed', failure_reason = 'window_expired', lease_until = NULL, next_retry_at = NULL, updated_at = $2
       WHERE id = $1 AND state = 'unknown'`,
      [op.id, at],
    );
    if (order === null || order.status === 'paid' || order.status === 'paid_partial') return;
    const open = await tx.query<{ id: string }>(
      `SELECT e.id FROM entitlements e JOIN order_units u ON u.id = e.unit_id
        WHERE u.order_id = $1 AND u.captured_verified_at IS NULL AND u.status NOT IN ('declined', 'mismatch')
        ORDER BY e.id`,
      [op.order_id],
    );
    for (const e of open.rows) {
      // A refused transition (an item already denied) is not an error here.
      await applyMoneyEvent(tx, d, { entitlement_id: e.id, event: 'unknown' });
    }
    await raiseOpsAlert(tx, d, {
      kind: 'payment_unresolved',
      order_id: op.order_id,
      unit_id: null,
      reason: 'window_expired',
      detail: { operation_id: op.id, kind: op.kind },
    });
  });
}

// ---------------------------------------------------------------------------------------------
// create

async function processCreate(d: PaymentsDeps, op: DueOp, out: Counts): Promise<void> {
  const order = await loadOrder(d.db, op.order_id);
  if (order === null) return;
  if (order.status !== 'created') {
    // The checkout moved on without this operation hearing of it.
    await d.db.query(
      `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1 AND state = 'unknown'`,
      [op.id, nowIso(d)],
    );
    return;
  }
  // PayPal keeps a key for 6 h; a resend is allowed only inside the 5 h window of the first send.
  // A create that was never sent has no window yet. Past it a read by order_ref is not possible.
  if (op.idem_safe_until !== null && Date.parse(nowIso(d)) >= Date.parse(op.idem_safe_until)) {
    await expireCreate(d, op);
    out.expired += 1;
    return;
  }
  const res = await resendCreate(d, order, op);
  if (res !== 'unknown') return;
  const fresh = await loadById(d.db, op.id);
  if (fresh !== null && fresh.state === 'unknown') {
    await schedule(d, fresh);
    out.still_unknown += 1;
  }
}

// No resend after the window and no way to look the order up: the create is closed. With no PayPal
// order id ever stored the order failed and nothing can have been charged (the buyer never had a
// way to pay); with one it stays unresolved. Either way a human gets one alert.
async function expireCreate(d: PaymentsDeps, op: DueOp): Promise<void> {
  await d.db.transaction(async (tx) => {
    const at = nowIso(d);
    await lockOrderRows(tx, op.order_id);
    const closed = await tx.query(
      `UPDATE operations SET state = 'failed', failure_reason = 'window_expired', lease_until = NULL, next_retry_at = NULL, updated_at = $2
       WHERE id = $1 AND state = 'unknown' RETURNING id`,
      [op.id, at],
    );
    if (closed.rows.length === 0) return;
    const stored = await tx.query(
      'SELECT 1 FROM provider_orders WHERE order_id = $1 AND provider_order_id IS NOT NULL LIMIT 1',
      [op.order_id],
    );
    if (stored.rows.length === 0) {
      await tx.query("UPDATE orders SET status = 'failed', updated_at = $2 WHERE id = $1", [
        op.order_id,
        at,
      ]);
      await declineUnits(tx, d, op.order_id, 'create_unresolved');
    } else {
      await tx.query("UPDATE orders SET status = 'unresolved', updated_at = $2 WHERE id = $1", [
        op.order_id,
        at,
      ]);
    }
    await raiseOpsAlert(tx, d, {
      kind: 'payment_unresolved',
      order_id: op.order_id,
      unit_id: null,
      reason: 'create_window_expired',
      detail: { operation_id: op.id, kind: op.kind },
    });
  });
}

// ---------------------------------------------------------------------------------------------
// refunds

async function processRefund(d: PaymentsDeps, op: DueOp, out: Counts): Promise<void> {
  const isEnded = ended(op, nowIso(d));
  const refundOp: RefundOp = {
    id: op.id,
    order_id: op.order_id,
    kind: op.kind === 'refund_readback' ? 'refund_readback' : 'refund',
    request_id: op.request_id,
    attempt: op.attempt,
    idem_safe_until: op.idem_safe_until,
  };
  await resumeRefund(d, refundOp, isEnded);
  const after = await loadById(d.db, op.id);
  if (after === null) return;
  if (after.state === 'failed' && after.failure_reason === 'window_expired') out.expired += 1;
  if (after.state === 'unknown') {
    await schedule(d, after);
    out.still_unknown += 1;
  }
}

// ---------------------------------------------------------------------------------------------
// abandoned checkouts (P17)

async function sweepAbandoned(d: PaymentsDeps, budget: number, out: Counts): Promise<number> {
  if (budget <= 0) return budget;
  const cutoff = addMs(nowIso(d), -d.config.abandoned_checkout_ms);
  const waiting = await d.db.query<{ id: string }>(
    `SELECT o.id FROM orders o
      WHERE o.created_at <= $1 AND (o.status = 'awaiting_buyer' OR (o.status = 'created' AND ${NOT_SENT}))
      ORDER BY o.created_at, o.id LIMIT $2`,
    [cutoff, budget],
  );
  for (const { id } of waiting.rows) {
    const order = await loadOrder(d.db, id);
    if (order === null) continue;
    const result = await abandonOne(d, order);
    if (result === 'skipped') continue;
    budget -= 1;
    out.processed += 1;
    if (result === 'abandoned') out.abandoned += 1;
  }
  return budget;
}

async function abandonOne(
  d: PaymentsDeps,
  order: OrderRow,
): Promise<'abandoned' | 'handled' | 'skipped'> {
  if (order.status === 'awaiting_buyer') {
    if (!(await d.switches.isOn('paypal_outbound'))) return 'skipped';
    const provider = (
      await d.db.query<{ provider_order_id: string | null }>(
        'SELECT provider_order_id FROM provider_orders WHERE order_id = $1 ORDER BY id LIMIT 1',
        [order.id],
      )
    ).rows[0]?.provider_order_id;
    if (provider !== undefined && provider !== null) {
      const read = await d.paypal.getOrder(provider);
      if (read.kind !== 'order') return 'skipped'; // blocked or unreadable: the next pass tries again
      if (read.units.some((u) => u.capture !== null)) {
        // Money is already at PayPal: never abandon. Take the order over, tell a human, and let
        // the read decide what is paid.
        return takeOver(d, order);
      }
      if (read.status === 'APPROVED') {
        // The buyer approved and never came back: the same capture path as a return, once.
        const r = await onBuyerReturn(d, {
          order_ref: order.order_ref,
          actor: { kind: 'buyer', buyer_id: order.buyer_id },
        });
        if (!r.ok && r.error.code === 'payments_paused') return 'skipped';
        const now = await loadOrder(d.db, order.id);
        if (now === null || now.status !== 'awaiting_buyer') return 'handled';
      }
    }
  }
  const done = await d.db.transaction(async (tx) => {
    const at = nowIso(d);
    await lockOrderRows(tx, order.id);
    const moved = await tx.query(
      `UPDATE orders SET status = 'abandoned', updated_at = $2 WHERE id = $1 AND status IN ('created', 'awaiting_buyer') RETURNING id`,
      [order.id, at],
    );
    if (moved.rows.length === 0) return false;
    await declineUnits(tx, d, order.id, 'abandoned');
    await tx.query(
      `UPDATE operations SET state = 'failed', failure_reason = 'declined', lease_until = NULL, next_retry_at = NULL, updated_at = $2
       WHERE order_id = $1 AND state = 'prepared'`,
      [order.id, at],
    );
    return true;
  });
  return done ? 'abandoned' : 'handled';
}

async function takeOver(d: PaymentsDeps, order: OrderRow): Promise<'handled' | 'skipped'> {
  const moved = await d.db.transaction(async (tx) => {
    const at = nowIso(d);
    await lockOrderRows(tx, order.id);
    const won = await tx.query(
      "UPDATE orders SET status = 'unresolved', updated_at = $2 WHERE id = $1 AND status = 'awaiting_buyer' RETURNING id",
      [order.id, at],
    );
    if (won.rows.length === 0) return false;
    await raiseOpsAlert(tx, d, {
      kind: 'unexpected_capture',
      order_id: order.id,
      unit_id: null,
      reason: 'abandon_sweep',
      detail: { trigger: 'abandon_sweep' },
    });
    await ensureReadbackOp(tx, d, { ...order, status: 'unresolved' }, at);
    return true;
  });
  if (!moved) return 'handled';
  const fresh = await loadOrder(d.db, order.id);
  if (fresh !== null) await readAndApply(d, fresh, 'poll');
  return 'handled';
}

// ---------------------------------------------------------------------------------------------
// re-read of paid orders for 7 days (catches refunds made at the PayPal dashboard); hourly, or
// every `reread_paid_every_ms`

async function rereadPaid(d: PaymentsDeps, budget: number, out: Counts): Promise<void> {
  if (budget <= 0) return;
  const every = rereadMs(d.config);
  const at = nowIso(d);
  const due = await d.db.query<{ id: string }>(
    `SELECT w.id FROM (${paidWatch(every)}) w
      WHERE w.next_at <= $1 AND $1 < w.verified_at + interval '7 days'
      ORDER BY w.next_at, w.id LIMIT $2`,
    [at, budget * 2], // spare candidates: another pass may claim some first
  );
  let done = 0;
  for (const { id } of due.rows) {
    if (done >= budget) return;
    // The slot is taken before the read, under the order's lock: of two passes at once one wins
    // the order, so one due re-read costs one provider call however many loops run.
    const claim = await claimReread(d, id, every);
    if (claim === null) continue;
    let r: Awaited<ReturnType<typeof readAndApply>>;
    try {
      r = await readAndApply(d, claim.order, 'poll');
    } catch (e) {
      await releaseReread(d, claim);
      throw e;
    }
    if (r.kind === 'paused') {
      await releaseReread(d, claim); // nothing was read: the re-read is still owed
      return;
    }
    out.processed += 1;
    done += 1;
  }
}

interface RereadClaim {
  order: OrderRow;
  at: string;
  /** the marker before the claim, for putting it back when nothing was read */
  prior: string;
}

// The marker of the last re-read: a settled read-back operation whose updated_at is moved forward.
// Still due, inside the 7 days and not claimed by another pass is re-checked under the lock.
async function claimReread(d: PaymentsDeps, id: Id, every: number): Promise<RereadClaim | null> {
  return d.db.transaction(async (tx) => {
    const at = nowIso(d);
    const order = await lockOrderRows(tx, id);
    if (order === null) return null;
    const still = await tx.query<Record<string, unknown>>(
      `SELECT w.verified_at, w.last_at FROM (${paidWatch(every)}) w
        WHERE w.id = $1 AND w.next_at <= $2 AND $2 < w.verified_at + interval '7 days'`,
      [id, at],
    );
    const row = still.rows[0];
    if (row === undefined) return null;
    const prior = isoOf(row['last_at']) ?? (isoOf(row['verified_at']) as string);
    const existing = await loadOperation(tx, order.id, 'readback', { lock: true });
    if (existing === null) {
      await insertOperation(tx, {
        id: d.ids.next('opr'),
        order_id: order.id,
        kind: 'readback',
        state: 'confirmed',
        request_id: readbackKeyFor(order.order_ref),
        lease_until: null,
        reconcile_until: null,
        next_retry_at: null,
        at,
      });
    } else {
      await tx.query(
        "UPDATE operations SET updated_at = $2 WHERE id = $1 AND state IN ('confirmed', 'failed')",
        [existing.id, at],
      );
    }
    return { order, at, prior };
  });
}

async function releaseReread(d: PaymentsDeps, claim: RereadClaim): Promise<void> {
  await d.db.query(
    `UPDATE operations SET updated_at = $3
      WHERE order_id = $1 AND kind = 'readback' AND state IN ('confirmed', 'failed') AND updated_at = $2`,
    [claim.order.id, claim.at, claim.prior],
  );
}
