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
import { issueReceiptIfChanged } from '@umsbx/receipts';
import type {
  Actor,
  DomainConfig,
  Id,
  IsoUtc,
  OrderRead,
  PaymentsDeps,
  SqlExecutor,
} from '@umsbx/contracts';
import { declineUnits, ensureReadbackOp, readApplyGates } from './apply';
import { captureOnce, reasonFor } from './capture';
import {
  endWholeOrder,
  expectedFor,
  isSent,
  lockGraph,
  lockOrderGraph,
  poFacts,
  poIn,
  refreshOrder,
  setPoState,
} from './composite';
import { captureKeyNumber, readbackKeyFor } from './keys';
import { matchReadback } from './match';
import { onBuyerReturn } from './return';
import {
  applyOneRead,
  declineMoved,
  readAndApply,
  resendCreate,
  retryCapture,
  TERMINAL,
} from './reconcile';
import { raiseOpsAlert, resumeRefund } from './refunds';
import type { RefundOp } from './refunds';
import {
  addMs,
  claimsOf,
  foreignCaptureIds,
  insertOperation,
  isoOf,
  loadOperation,
  loadOperationFor,
  loadOrder,
  loadProviderOrders,
  loadUnits,
  lockOrderRows,
  unitsOf,
} from './store';
import type { OperationRow, OrderRow, ProviderOrderRow, UnitRow } from './store';

type Read = Extract<OrderRead, { kind: 'order' }>;
const PACK_WINDOW_DEFAULT_MS = 3_600_000;

const earlier = (a: string, b: string): string => (Date.parse(a) <= Date.parse(b) ? a : b);

/**
 * The next poll of an unknown operation: the schedule is counted from `anchor` (the first send),
 * +30 s, +2 min, +10 min, +1 h, +1 h ... cumulatively, and the next poll is the first scheduled
 * time after `now`, so a late run does not stack delays. Never later than `until`; once `until` has
 * passed, one last backoff step after `now` (never a time in the past).
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
  // The window is over and the operation is still open (the read was blocked, the provider was
  // down): its end is in the past, so capping at it would make the operation due again at once,
  // on every pass. Try again one last backoff step from now.
  if (Date.parse(until) <= at) {
    const last = list[list.length - 1] ?? 30_000;
    return new Date(at + Math.max(1, last)).toISOString();
  }
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

// The continuation (DP-2b): a PayPal order of a pack still waiting for its capture (approved, or still
// awaiting the buyer) whose sibling had a capture sent (overview section 3: its own capture operation
// has first_sent_at and its state is not approved, or it is in flight or captured). `sent_at` is when
// the latest sibling was sent. A candidate is `fresh` when nothing has touched it since: it is due at
// once; one that was touched (a reopen, a pass that changed nothing) is due `every` ms after that.
const CONTINUATION = `
  SELECT po.id, po.order_id, po.updated_at, sib.sent_at, (po.updated_at <= sib.sent_at) AS fresh
    FROM provider_orders po
    JOIN LATERAL (
      SELECT max(COALESCE(c.first_sent_at, s.updated_at)) AS sent_at
        FROM provider_orders s
        LEFT JOIN operations c ON c.provider_order_ref = s.id AND c.kind = 'capture'
       WHERE s.order_id = po.order_id AND s.id <> po.id
         AND (s.state IN ('capture_requested', 'capture_claimed', 'unresolved', 'captured')
              OR (s.state NOT IN ('prepared', 'awaiting_buyer', 'approved') AND c.first_sent_at IS NOT NULL))
    ) sib ON sib.sent_at IS NOT NULL
   WHERE po.state IN ('approved', 'awaiting_buyer') AND po.provider_order_id IS NOT NULL`;
interface Candidate {
  id: Id;
  order_id: Id;
  /** The last time anything touched the PayPal order. */
  updated_at: string;
  /** When the latest sibling was sent: the poll schedule of a waiting PayPal order is counted from it. */
  sent_at: string;
  fresh: boolean;
}
async function continuationCandidates(db: SqlExecutor): Promise<Candidate[]> {
  const found = await db.query<Record<string, unknown>>(
    `SELECT k.id, k.order_id, k.updated_at, k.sent_at, k.fresh FROM (${CONTINUATION}) k ORDER BY k.updated_at, k.id LIMIT 200`,
  );
  return found.rows.map((r) => ({
    id: r['id'] as string,
    order_id: r['order_id'] as string,
    updated_at: isoOf(r['updated_at']) as string,
    sent_at: isoOf(r['sent_at']) as string,
    fresh: r['fresh'] === true,
  }));
}
const DEFAULT_BACKOFF = [30_000, 120_000, 600_000, 3_600_000];
/**
 * When a candidate is next due. One nothing has touched since its sibling was sent is due at once. One
 * that was touched (a reopen, a pass that changed nothing) is polled on the backoff schedule counted
 * from the send of its sibling (30 s, 2 min, 10 min, 1 h, 1 h ...), so a PayPal order that waits for
 * the buyer costs about one read an hour, not one per pass.
 */
function dueOfCandidate(
  config: Partial<Pick<DomainConfig, 'reconcile_backoff_ms'>>,
  c: Candidate,
): string {
  if (c.fresh) return c.updated_at;
  return nextPollAt(
    { reconcile_backoff_ms: config.reconcile_backoff_ms ?? DEFAULT_BACKOFF },
    c.sent_at,
    c.updated_at,
    addMs(c.sent_at, 365 * 86_400_000),
  );
}

export async function nextDueAt(
  db: SqlExecutor,
  config: Pick<DomainConfig, 'abandoned_checkout_ms'> &
    Partial<Pick<DomainConfig, 'reread_paid_every_ms' | 'pack_approval_window_ms'>> &
    Partial<Pick<DomainConfig, 'reconcile_backoff_ms'>> = { abandoned_checkout_ms: 86_400_000 },
): Promise<IsoUtc | null> {
  const found = await db.query<Record<string, unknown>>(
    `SELECT
       (SELECT min(next_retry_at) FROM operations WHERE state = 'unknown') AS retry_at,
       (SELECT min(lease_until) FROM operations WHERE state = 'sent') AS lease_at,
       (SELECT min(o.created_at) FROM orders o WHERE o.status = 'awaiting_buyer'
           OR (o.status = 'created' AND ${NOT_SENT})) AS waiting_at,
       (SELECT min(p.first_approved_at) FROM provider_orders p JOIN orders o ON o.id = p.order_id
         WHERE o.status = 'awaiting_buyer' AND p.route = 'per_publisher') AS pack_at,
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
  // The pack approval window runs from the first approval we saw; the due pass enforces it.
  const pack = isoOf(row['pack_at']);
  if (pack !== null)
    times.push(addMs(pack, config.pack_approval_window_ms ?? PACK_WINDOW_DEFAULT_MS));
  for (const c of await continuationCandidates(db)) times.push(dueOfCandidate(config, c));
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
  provider_order_ref: (r['provider_order_ref'] as string | null) ?? null,
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
  d: Pick<PaymentsDeps, 'clock' | 'config' | 'ids'>,
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
    // The PayPal order of this capture goes back to unresolved; the order status follows (composite.ts).
    const ref = (
      await tx.query<{ provider_order_ref: string | null }>(
        'SELECT provider_order_ref FROM operations WHERE id = $1',
        [op.id],
      )
    ).rows[0]?.provider_order_ref;
    const pos = await loadProviderOrders(tx, op.order_id);
    const po =
      ref === undefined || ref === null
        ? pos.length === 1
          ? pos[0]
          : undefined
        : pos.find((p) => p.id === ref);
    if (po !== undefined) {
      await setPoState(tx, po.id, 'unresolved', at, ['capture_requested', 'capture_claimed']);
      await refreshOrder(tx, d, op.order_id);
    }
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
// (never sent: no first_sent_at) is left to a full pass. Since CO-4 an ended put-off refund is
// closed unsent, so it could be picked up here too; the clause stays as it is until a test with
// that closing in place shows a money_only pass needs it (the close costs a read of the order).
const MONEY_OR_CALL_FREE = `(kind IN ${MONEY_KINDS}
          OR (kind = 'create' AND ((idem_safe_until IS NOT NULL AND idem_safe_until <= $1)
                OR EXISTS (SELECT 1 FROM provider_orders p WHERE p.id = operations.provider_order_ref AND p.state <> 'prepared')
                OR (provider_order_ref IS NULL
                    AND EXISTS (SELECT 1 FROM orders o WHERE o.id = operations.order_id AND o.status <> 'created'))))
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
  // One item per PayPal order for reads (one read serves its capture and its read-back operation), one
  // per operation otherwise; items keep the order of their earliest operation.
  const items = new Map<string, DueOp[]>();
  for (const row of rows.rows) {
    const op = toDueOp(row);
    const key =
      op.kind === 'capture' || op.kind === 'readback'
        ? `po:${op.provider_order_ref ?? op.order_id}`
        : `op:${op.id}`;
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

  // A pack whose first capture was sent always finishes: money work, so it also runs when the polling
  // allowance is spent. Each PayPal order picked costs one item of the budget.
  budget = await continuePacks(d, budget, out);
  if (moneyOnly) return announcePass(d, out);
  budget = await sweepAbandoned(d, budget, out);
  await rereadPaid(d, budget, out);
  return announcePass(d, out);
}

/**
 * API-C: a pass that took at least one item writes settlement.completed in its own transaction: how many
 * items it checked and how many it settled (the rest are still unknown). An idle pass, and a pass with
 * the outbound switch off (which returns before this), write nothing. The work is already committed, so a
 * failure to write the event is logged and does not undo or fail the pass.
 */
async function announcePass(d: PaymentsDeps, out: Counts): Promise<Counts> {
  const outbox = d.outbox;
  if (outbox === undefined || out.processed <= 0) return out;
  try {
    await d.db.transaction(async (tx) => {
      await outbox.append(tx, {
        type: 'settlement.completed',
        payload: {
          pass_id: d.ids.next('pas'),
          checked: out.processed,
          fixed: out.processed - out.still_unknown,
          completed_at: nowIso(d),
        },
      });
    });
  } catch (e) {
    d.log.log({
      msg: 'payments.due.event_failed',
      level: 'error',
      fields: { error: e instanceof Error ? e.message : 'unknown' },
    });
  }
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
// reads: capture and read-back operations of one PayPal order

const SETTLED_PO: ReadonlySet<ProviderOrderRow['state']> = new Set([
  'declined',
  'failed',
  'abandoned',
  'frozen',
]);

/**
 * DP-2c: a PayPal order of a pack that the due pass ends without money (declined, failed, abandoned or
 * frozen) changes what the receipt shows for its items (not charged, on hold). The receipt is reissued
 * with the same function apply.ts uses: a new version only when the body changed, and none at all while
 * no unit of the order is verified (then the call answers `no_verified_capture` and writes nothing).
 */
async function reissueReceipt(tx: SqlExecutor, d: PaymentsDeps, order_id: Id): Promise<void> {
  await issueReceiptIfChanged(tx, d, { order_id });
}

/** The PayPal order the claimed operations belong to: their own reference, else the only one. */
function poOfClaimed(
  pos: readonly ProviderOrderRow[],
  claimed: readonly DueOp[],
): ProviderOrderRow | undefined {
  const ref = claimed.find((o) => o.provider_order_ref !== null)?.provider_order_ref ?? null;
  return ref !== null ? pos.find((p) => p.id === ref) : pos.length === 1 ? pos[0] : undefined;
}

async function processRead(
  d: PaymentsDeps,
  order_id: Id,
  claimed: DueOp[],
  out: Counts,
): Promise<void> {
  const order = await loadOrder(d.db, order_id);
  if (order === null) return;
  const po = poOfClaimed(await loadProviderOrders(d.db, order_id), claimed);
  if (TERMINAL.has(order.status)) {
    // Frozen, failed or abandoned: a human's or finished. The operations stop here.
    await d.db.query(
      `UPDATE operations SET state = 'failed', failure_reason = $2, lease_until = NULL, next_retry_at = NULL, updated_at = $3
       WHERE order_id = $1 AND kind IN ('capture', 'readback') AND state = 'unknown'`,
      [order_id, order.status === 'frozen' ? 'mismatch' : 'declined', nowIso(d)],
    );
    return;
  }
  if (po !== undefined && SETTLED_PO.has(po.state)) {
    // This PayPal order is over without money (or on hold) while the pack goes on: its operations stop.
    await d.db.query(
      `UPDATE operations SET state = 'failed', failure_reason = $2, lease_until = NULL, next_retry_at = NULL, updated_at = $3
       WHERE order_id = $1 AND kind IN ('capture', 'readback') AND state = 'unknown'
         AND (provider_order_ref = $4 OR (provider_order_ref IS NULL AND $5 = 'single'))`,
      [order_id, po.state === 'frozen' ? 'mismatch' : 'declined', nowIso(d), po.id, po.route],
    );
    return;
  }
  // Read first, always (RB-2). At the end of the window this is the last read.
  const outcome = await readAndApply(d, order, 'poll', po === undefined ? undefined : [po.id]);
  if (outcome.kind === 'paused') {
    await release(d, claimed);
    return;
  }
  if (outcome.kind === 'applied' && po !== undefined) {
    const again = await maybeRetryCapture(d, order, po, outcome.read);
    if (again === 'paused') {
      await release(d, claimed);
      return;
    }
  }
  await settleRead(d, order_id, claimed, out, po);
}

// P3: a capture whose answer was lost and a read that shows no capture on any unit, an approved
// order, inside 5 h of the first send, once (1 + max_capture_retries sends), and only when the
// content is deliverable: send again with the same key, then read again. Per PayPal order, with that
// PayPal order's own operation and key.
async function maybeRetryCapture(
  d: PaymentsDeps,
  order: OrderRow,
  po: ProviderOrderRow,
  read: Read,
): Promise<'done' | 'paused'> {
  // The operation is read fresh; the capture retry takes the locks and refuses a PayPal order that is
  // not in flight any more, so the rows passed in need not be current.
  const cap = await loadOperationFor(d.db, po, 'capture');
  if (cap === null || cap.state !== 'unknown') return 'done';
  if (read.status !== 'APPROVED' || read.units.some((u) => u.capture !== null)) return 'done';
  if (cap.idem_safe_until === null || Date.parse(nowIso(d)) >= Date.parse(cap.idem_safe_until)) {
    return 'done';
  }
  if (cap.attempt > d.config.max_capture_retries) return 'done';
  if ((await readApplyGates(d, order.id)).not_ready.length > 0) return 'done';
  const sent = await retryCapture(d, order, cap, read.provider_order_id, po);
  if (sent !== 'claim') return 'done';
  const fresh = await loadOrder(d.db, order.id);
  if (fresh === null) return 'done';
  const second = await readAndApply(d, fresh, 'poll', [po.id]);
  return second.kind === 'paused' ? 'paused' : 'done';
}

// Whatever is still unknown after the read is polled again, or, at the window end, closed.
async function settleRead(
  d: PaymentsDeps,
  order_id: Id,
  claimed: DueOp[],
  out: Counts,
  po: ProviderOrderRow | undefined,
): Promise<void> {
  const unknown = await d.db.query<Record<string, unknown>>(
    `SELECT * FROM operations WHERE order_id = $1 AND kind IN ('capture', 'readback') AND state = 'unknown'
        AND ($2::text IS NULL OR provider_order_ref = $2 OR (provider_order_ref IS NULL AND $3 = 'single'))
      ORDER BY created_at, id`,
    [order_id, po === undefined ? null : po.id, po === undefined ? null : po.route],
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
// For a pack only the items of this PayPal order become unknown.
async function expireRead(d: PaymentsDeps, op: DueOp): Promise<void> {
  await d.db.transaction(async (tx) => {
    const at = nowIso(d);
    const graph = await lockOrderGraph(tx, op.order_id);
    const order = graph?.order ?? null;
    const po =
      graph === null || op.provider_order_ref === null
        ? undefined
        : graph.pos.find((p) => p.id === op.provider_order_ref);
    await tx.query(
      `UPDATE operations SET state = 'failed', failure_reason = 'window_expired', lease_until = NULL, next_retry_at = NULL, updated_at = $2
       WHERE id = $1 AND state = 'unknown'`,
      [op.id, at],
    );
    if (order === null || order.status === 'paid' || order.status === 'paid_partial') return;
    if (po !== undefined && po.state === 'captured') return;
    const open = await tx.query<{ id: string }>(
      `SELECT e.id FROM entitlements e JOIN order_units u ON u.id = e.unit_id
        WHERE u.order_id = $1 AND u.captured_verified_at IS NULL AND u.status NOT IN ('declined', 'mismatch')
          AND ($2::text IS NULL OR u.provider_order_ref = $2)
        ORDER BY e.id`,
      [op.order_id, po !== undefined && po.route === 'per_publisher' ? po.id : null],
    );
    for (const e of open.rows) {
      // A refused transition (an item already denied) is not an error here.
      await applyMoneyEvent(tx, d, { entitlement_id: e.id, event: 'unknown' });
    }
    await raiseOpsAlert(tx, d, {
      kind: 'payment_unresolved',
      order_id: op.order_id,
      unit_id: null,
      reason: po === undefined ? 'window_expired' : reasonFor(po, 'window_expired'),
      detail: { operation_id: op.id, kind: op.kind },
    });
  });
}

// ---------------------------------------------------------------------------------------------
// create

async function processCreate(d: PaymentsDeps, op: DueOp, out: Counts): Promise<void> {
  const order = await loadOrder(d.db, op.order_id);
  if (order === null) return;
  const po = poOfClaimed(await loadProviderOrders(d.db, op.order_id), [op]);
  if (po === undefined) return;
  // The checkout moved on without this operation hearing of it: this PayPal order is no longer waiting
  // for its create (for a single order that is the order status, as ever).
  if (po.state !== 'prepared') {
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

// No resend after the window and no way to look the order up: the create is closed. A PayPal order
// that never got a provider order id never existed at PayPal and nothing can have been charged (the
// buyer never had a way to pay): the whole order fails, every PayPal order of it. With an id stored
// it stays unresolved. Either way a human gets one alert.
async function expireCreate(d: PaymentsDeps, op: DueOp): Promise<void> {
  await d.db.transaction(async (tx) => {
    const at = nowIso(d);
    const graph = await lockGraph(tx, op.order_id);
    const closed = await tx.query(
      `UPDATE operations SET state = 'failed', failure_reason = 'window_expired', lease_until = NULL, next_retry_at = NULL, updated_at = $2
       WHERE id = $1 AND state = 'unknown' RETURNING id`,
      [op.id, at],
    );
    if (closed.rows.length === 0) return;
    const po = poOfClaimed(graph.pos, [op]);
    if (po === undefined || po.provider_order_id === null) {
      const moved = await endWholeOrder(tx, d, op.order_id, 'failed');
      await declineMoved(tx, d, op.order_id, moved, graph.pos, 'create_unresolved');
      await reissueReceipt(tx, d, op.order_id);
    } else {
      await setPoState(tx, po.id, 'unresolved', at, ['prepared', 'awaiting_buyer', 'approved']);
      await refreshOrder(tx, d, op.order_id);
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
// abandoned checkouts (P17): the 24 h sweep, and the pack approval window on the due pass

async function sweepAbandoned(d: PaymentsDeps, budget: number, out: Counts): Promise<number> {
  if (budget <= 0) return budget;
  const at = nowIso(d);
  const cutoff = addMs(at, -d.config.abandoned_checkout_ms);
  // A pack whose approval window has run out since we first saw an approval is due as well, so the
  // step-page promise ("the whole order is cancelled") holds for a buyer who never comes back.
  const windowCutoff = addMs(at, -(d.config.pack_approval_window_ms ?? PACK_WINDOW_DEFAULT_MS));
  const waiting = await d.db.query<{ id: string }>(
    `SELECT o.id FROM orders o
      WHERE (o.status = 'awaiting_buyer' OR (o.status = 'created' AND ${NOT_SENT}))
        AND (o.created_at <= $1
             OR (o.status = 'awaiting_buyer'
                 AND (SELECT min(q.first_approved_at) FROM provider_orders q
                       WHERE q.order_id = o.id AND q.route = 'per_publisher') <= $3))
      ORDER BY o.created_at, o.id LIMIT $2`,
    [cutoff, budget, windowCutoff],
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

/**
 * Nothing was sent for this order and it waited too long (24 h, or a pack past its window). Every
 * PayPal order is read (the stored id only). Money already at PayPal on any of them: never abandon,
 * take it over. All APPROVED: the capture path of a return, once (P17). Anything else: the whole order
 * is abandoned, nothing charged. A pack is never abandoned while a capture was sent.
 */
async function abandonOne(
  d: PaymentsDeps,
  order: OrderRow,
): Promise<'abandoned' | 'handled' | 'skipped'> {
  let gone = false;
  if (order.status === 'awaiting_buyer') {
    if (!(await d.switches.isOn('paypal_outbound'))) return 'skipped';
    const pos = (await loadProviderOrders(d.db, order.id)).filter(
      (p) =>
        p.provider_order_id !== null && (p.state === 'awaiting_buyer' || p.state === 'approved'),
    );
    const reads = new Map<Id, OrderRead>();
    // A PayPal order that no longer exists (HTTP 404) is a definite answer: nothing can be captured
    // on it, so the checkout is over (BU-9), for a single order and for a pack (it lapsed).
    for (const po of pos) {
      const read = await d.paypal.getOrder(po.provider_order_id as string);
      // blocked or unreadable: the next pass tries again
      if (read.kind !== 'order' && read.kind !== 'not_found') return 'skipped';
      if (read.kind === 'not_found') gone = true;
      reads.set(po.id, read);
    }
    const found = pos.filter((p) => {
      const r = reads.get(p.id);
      return r !== undefined && r.kind === 'order' && r.units.some((u) => u.capture !== null);
    });
    if (found.length > 0) {
      // Money is already at PayPal: never abandon. Take the order over, tell a human, and let the
      // read decide what is paid.
      return takeOver(d, order, found);
    }
    const allApproved =
      pos.length > 0 &&
      pos.every((p) => {
        const r = reads.get(p.id);
        return r !== undefined && r.kind === 'order' && r.status === 'APPROVED';
      });
    if (allApproved) {
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
  const done = await abandonLocked(d, order, gone);
  if (done === 'abandoned' && gone) {
    d.log.log({
      msg: 'payments.due.abandoned_not_found',
      level: 'info',
      fields: { order_ref: order.order_ref },
    });
  }
  return done;
}

/**
 * The abandon transition itself, under the row locks. The 24 h sweep calls it as it always did (no `strict`).
 * A buyer's own cancel (cancel.ts, ORDER-A) calls it with `strict`, which adds guards and one audit row and
 * nothing else: the order must already wait for the buyer (not merely be created), every PayPal order must
 * be `prepared` or `awaiting_buyer` (none approved), no operation of the order may be `sent` or `unknown`,
 * and no unit may have a capture. Any guard that fails answers 'skipped' (nothing is changed). 'handled'
 * means the order is no longer waiting. The result 'abandoned' is the only one that wrote anything.
 */
export async function abandonLocked(
  d: PaymentsDeps,
  order: OrderRow,
  gone: boolean,
  strict?: { actor: Actor },
): Promise<'abandoned' | 'handled' | 'skipped'> {
  return d.db.transaction(async (tx): Promise<'abandoned' | 'handled' | 'skipped'> => {
    const at = nowIso(d);
    const graph = await lockGraph(tx, order.id);
    // Only an order that still waits for the buyer.
    if (graph.order.status !== 'created' && graph.order.status !== 'awaiting_buyer') {
      return 'handled';
    }
    if (strict !== undefined && graph.order.status !== 'awaiting_buyer') return 'handled';
    // Never after a send, whatever the status says.
    const facts = await poFacts(tx, order.id);
    if (facts.some(isSent)) return gone || strict !== undefined ? 'skipped' : 'handled';
    if (strict !== undefined) {
      // A buyer's cancel never takes a PayPal order that was approved here (it is finished, not cancelled),
      // and never an order with anything in flight or any capture. Re-checked under the lock.
      if (graph.pos.some((p) => p.state !== 'prepared' && p.state !== 'awaiting_buyer')) {
        return 'skipped';
      }
      const flying = await tx.query(
        "SELECT 1 FROM operations WHERE order_id = $1 AND state IN ('sent', 'unknown') LIMIT 1",
        [order.id],
      );
      if (flying.rows.length > 0) return 'skipped';
    }
    if (gone || strict !== undefined) {
      // BU-9, re-checked under the lock: a capture operation that was sent or is unknown may have taken
      // money whose answer was lost, a unit with a capture id has been paid, and a PayPal order a capture
      // was aimed at is not decided here: the order stays as it is and the reconciler owns it.
      if (graph.pos.some((p) => !UNSENT_STATES.has(p.state))) return 'skipped';
      const inFlight = await tx.query(
        "SELECT 1 FROM operations WHERE order_id = $1 AND kind = 'capture' AND state IN ('sent', 'unknown') LIMIT 1",
        [order.id],
      );
      if (inFlight.rows.length > 0) return 'skipped';
      const paid = await tx.query(
        'SELECT 1 FROM order_units WHERE order_id = $1 AND (capture_id IS NOT NULL OR captured_verified_at IS NOT NULL) LIMIT 1',
        [order.id],
      );
      if (paid.rows.length > 0) return 'skipped';
    }
    // The status is created or awaiting_buyer, so some PayPal order is still open and moves.
    const moved = await endWholeOrder(tx, d, order.id, 'abandoned');
    await declineMoved(tx, d, order.id, moved, graph.pos, 'abandoned');
    await reissueReceipt(tx, d, order.id);
    await tx.query(
      `UPDATE operations SET state = 'failed', failure_reason = 'declined', lease_until = NULL, next_retry_at = NULL, updated_at = $2
       WHERE order_id = $1 AND state = 'prepared'`,
      [order.id, at],
    );
    if (strict !== undefined) {
      await d.audit.record(tx, {
        actor: strict.actor,
        action: 'order.cancelled_by_buyer',
        target: order.id,
        reason: null,
        detail: { order_ref: order.order_ref, provider_orders: graph.pos.length },
      });
    }
    return 'abandoned';
  });
}

const UNSENT_STATES: ReadonlySet<ProviderOrderRow['state']> = new Set([
  'prepared',
  'awaiting_buyer',
  'approved',
]);

async function takeOver(
  d: PaymentsDeps,
  order: OrderRow,
  found: readonly ProviderOrderRow[],
): Promise<'handled' | 'skipped'> {
  const taken = await d.db.transaction(async (tx) => {
    const at = nowIso(d);
    const graph = await lockGraph(tx, order.id);
    const ids: Id[] = [];
    for (const f of found) {
      const po = poIn(graph, f.id);
      if (!(await setPoState(tx, po.id, 'unresolved', at, ['awaiting_buyer', 'approved'])))
        continue;
      ids.push(po.id);
      await raiseOpsAlert(tx, d, {
        kind: 'unexpected_capture',
        order_id: order.id,
        unit_id: null,
        reason: reasonFor(po, 'abandon_sweep'),
        detail: { trigger: 'abandon_sweep' },
      });
      await ensureReadbackOp(tx, d, graph.order, at, { ...po, state: 'unresolved' });
    }
    if (ids.length > 0) await refreshOrder(tx, d, order.id);
    return ids;
  });
  // Nothing taken (the PayPal orders moved on meanwhile): the empty list reads nothing.
  const fresh = await loadOrder(d.db, order.id);
  if (fresh !== null) await readAndApply(d, fresh, 'poll', taken);
  return 'handled';
}

// ---------------------------------------------------------------------------------------------
// the continuation (DP-2b): a pack whose first capture was sent always finishes
//
// Every PayPal order of the pack that is still waiting (approved, or still awaiting the buyer) while a
// sibling had a capture sent is picked here: read fresh, then captured with its own key after a match,
// or read back when a capture is already there, or ended as not charged (declined) only on the strict
// rule. The sweep never sees these orders (it looks only at awaiting_buyer), and a pack is never
// abandoned once a capture was sent.

const hasCapture = (r: Read): boolean => r.units.some((u) => u.capture !== null);

async function continuePacks(d: PaymentsDeps, budget: number, out: Counts): Promise<number> {
  if (budget <= 0) return budget;
  for (const c of await continuationCandidates(d.db)) {
    if (budget <= 0) break;
    if (Date.parse(dueOfCandidate(d.config, c)) > Date.parse(nowIso(d))) continue;
    let result: 'done' | 'skipped';
    try {
      result = await continueOne(d, c.id, c.order_id, c.sent_at);
    } catch (e) {
      d.log.log({
        msg: 'payments.due.item_failed',
        level: 'error',
        fields: {
          provider_order: c.id,
          kind: 'continuation',
          error: e instanceof Error ? e.message : 'unknown',
        },
      });
      await touchPo(d, c.id);
      result = 'done';
    }
    if (result === 'skipped') continue;
    budget -= 1;
    out.processed += 1;
  }
  return budget;
}

/** Wait for the next round: the PayPal order is picked again `every` ms from now, not at once. */
async function touchPo(d: PaymentsDeps, po_id: Id): Promise<void> {
  await d.db.query(
    "UPDATE provider_orders SET updated_at = $2 WHERE id = $1 AND state IN ('approved', 'awaiting_buyer')",
    [po_id, nowIso(d)],
  );
}

/**
 * The deadline of a PayPal order that is waiting for its capture: its first approval (or the first
 * approval of the pack, or the first send) plus the pack window plus the reconcile window, or the D-014
 * key cap, whichever comes first. `capped` says the keys are used up: the next try would be refused.
 */
async function deadlineOf(
  d: PaymentsDeps,
  pos: readonly ProviderOrderRow[],
  po: ProviderOrderRow,
  sent_at: string,
): Promise<{ at: string; capped: boolean }> {
  const firsts = pos
    .map((p) => p.first_approved_at)
    .filter((t): t is string => t !== null)
    .sort();
  // The first approval we saw (of this PayPal order, else of the pack); with none, the send of its sibling.
  const base = po.first_approved_at ?? firsts[0] ?? sent_at;
  const window = d.config.pack_approval_window_ms ?? PACK_WINDOW_DEFAULT_MS;
  const at = addMs(base, window + d.config.reconcile_window_ms);
  const cap = await loadOperationFor(d.db, po, 'capture');
  let capped = false;
  if (cap !== null && cap.state === 'prepared' && cap.first_sent_at !== null) {
    // The same arithmetic as the capture gate (capture.ts): the next try is a new key.
    const keyNumber = captureKeyNumber(po.po_ref, cap.request_id) + 1;
    const attempt = cap.attempt + 1;
    capped =
      keyNumber > 1 + d.config.max_capture_retries ||
      attempt > 2 * (1 + d.config.max_capture_retries);
  }
  return { at, capped };
}

async function continueOne(
  d: PaymentsDeps,
  po_id: Id,
  order_id: Id,
  sent_at: string,
): Promise<'done' | 'skipped'> {
  const order = await loadOrder(d.db, order_id);
  const pos = await loadProviderOrders(d.db, order_id);
  const po = pos.find((p) => p.id === po_id);
  if (order === null || po === undefined || po.provider_order_id === null) return 'skipped';
  if (po.state !== 'approved' && po.state !== 'awaiting_buyer') return 'skipped';
  // Outside any transaction: the port may use the database itself.
  if (!(await d.switches.isOn('paypal_outbound'))) return 'skipped';

  // 1. Read it fresh.
  const read = await d.paypal.getOrder(po.provider_order_id);
  if (read.kind === 'blocked') return 'skipped';
  const deadline = await deadlineOf(d, pos, po, sent_at);
  const passed = deadline.capped || Date.parse(nowIso(d)) >= Date.parse(deadline.at);
  if (read.kind !== 'order' && read.kind !== 'not_found') {
    // An answer that proves nothing: not charged is never concluded from it. At the deadline a human is told once.
    if (passed) {
      await d.db.transaction((tx) =>
        raiseOpsAlert(tx, d, {
          kind: 'payment_unresolved',
          order_id,
          unit_id: null,
          reason: reasonFor(po, 'deadline_unreadable'),
          detail: { phase: 'continuation' },
        }),
      );
    }
    await touchPo(d, po.id);
    return 'done';
  }

  // 2. A capture is there (COMPLETED, or any capture on a unit): read-back and match. That ends in
  // `captured` or `frozen`, never in `declined`.
  if (read.kind === 'order' && hasCapture(read)) {
    await readBackFound(d, order, po, read);
    return 'done';
  }
  // 3. Case 2a: VOIDED or gone, with no capture on the unit. Case 2b: the deadline has passed and the
  // fresh read shows no capture, whatever the status.
  if (read.kind === 'not_found' || read.status === 'VOIDED') {
    if (!(await declinePo(d, order_id, po.id, 'approval_lapsed'))) await touchPo(d, po.id);
    return 'done';
  }
  if (passed) {
    if (!(await declinePo(d, order_id, po.id, 'deadline_passed'))) await touchPo(d, po.id);
    return 'done';
  }
  if (read.status !== 'APPROVED') {
    await touchPo(d, po.id); // the buyer has to act at PayPal; the pack waits
    return 'done';
  }

  // 4. APPROVED, no capture: the match must hold before anything is sent.
  const mine = unitsOf(await loadUnits(d.db, order_id), po);
  const m = matchReadback({
    expected: expectedFor(
      order.expected,
      mine.map((u) => u.reference_id),
    ),
    read,
    provider_order_id: po.provider_order_id,
    claims: claimsOf(mine).map((c) => ({ ...c, capture_id: null, claimed_at: null })),
    foreign_capture_ids: await foreignCaptureIds(
      d.db,
      order_id,
      read.units.map((u) => (u.capture === null ? null : u.capture.capture_id)),
      mine.map((u) => u.id),
    ),
  });
  const bad =
    m.level === 'order'
      ? [{ field: m.field, unit: null as UnitRow | null }]
      : m.units
          .filter((u) => u.result !== 'no_capture')
          .map((u) => ({
            field: u.result === 'mismatch' ? (u.field ?? 'unknown') : 'capture_before_capture',
            unit: mine.find((x) => x.reference_id === u.reference_id) ?? null,
          }));
  if (bad.length > 0) {
    await holdPo(d, order, po, bad);
    return 'done';
  }
  // Paused checkout, or an item that cannot be delivered: nothing is sent into a locked door.
  if (!(await d.switches.isOn('checkout_enabled'))) {
    await touchPo(d, po.id);
    return 'done';
  }
  if ((await readApplyGates(d, order_id)).not_ready.length > 0) {
    await touchPo(d, po.id);
    return 'done';
  }

  // 5. Capture it through the DP-2a gate with its own key, then read it back.
  if (po.state === 'awaiting_buyer') {
    // The gate needs `approved`. If another actor moved the PayPal order meanwhile, the gate refuses (lost).
    await d.db.transaction(async (tx) => {
      await lockGraph(tx, order_id);
      const at = nowIso(d);
      if (!(await setPoState(tx, po.id, 'approved', at, ['awaiting_buyer']))) return;
      await tx.query(
        `UPDATE provider_orders SET first_approved_at = COALESCE(first_approved_at, $2), status = 'APPROVED' WHERE id = $1`,
        [po.id, at],
      );
      await refreshOrder(tx, d, order_id);
    });
  }
  const outcome = await captureOnce(d, order, po.provider_order_id, null, po);
  switch (outcome.kind) {
    case 'lost':
    case 'capped':
      await touchPo(d, po.id);
      return 'done';
    case 'blocked':
    case 'unknown':
    case 'payer_action':
    case 'not_approved':
    case 'frozen':
      return 'done';
    case 'claim':
    case 'read_decides':
      break;
  }
  // A separate read of this PayPal order; the claim never unlocks anything by itself.
  const after = await d.paypal.getOrder(po.provider_order_id);
  if (after.kind !== 'order') {
    await d.db.transaction(async (tx) => {
      const at = nowIso(d);
      const graph = await lockGraph(tx, order_id);
      const cur = poIn(graph, po.id);
      if (cur.state === 'capture_requested' || cur.state === 'capture_claimed') {
        await setPoState(tx, po.id, 'unresolved', at, [cur.state]);
        await refreshOrder(tx, d, order_id);
      }
      await ensureReadbackOp(tx, d, graph.order, at, cur);
    });
    return 'done';
  }
  await applyOneRead(d, order, po, after, 'capture');
  return 'done';
}

/** A capture shows on a PayPal order we still thought waiting: it becomes unresolved and the read is applied (match, verify or freeze). */
async function readBackFound(
  d: PaymentsDeps,
  order: OrderRow,
  po: ProviderOrderRow,
  read: Read,
): Promise<void> {
  const cap = await loadOperationFor(d.db, po, 'capture');
  const weSent = cap !== null && cap.first_sent_at !== null;
  const moved = await d.db.transaction(async (tx) => {
    const at = nowIso(d);
    const graph = await lockGraph(tx, order.id);
    const cur = poIn(graph, po.id);
    if (!(await setPoState(tx, cur.id, 'unresolved', at, ['awaiting_buyer', 'approved']))) {
      return false;
    }
    if (!weSent) {
      // Money nobody here sent: a human must know how it came about; the read decides what is paid.
      await raiseOpsAlert(tx, d, {
        kind: 'unexpected_capture',
        order_id: order.id,
        unit_id: null,
        reason: reasonFor(cur, 'continuation_capture_found'),
        detail: { trigger: 'continuation' },
      });
    }
    // A capture operation that was waiting to be sent has nothing left to send.
    await tx.query(
      `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2
        WHERE order_id = $1 AND kind = 'capture' AND state = 'prepared' AND provider_order_ref = $3`,
      [order.id, at, cur.id],
    );
    await ensureReadbackOp(tx, d, graph.order, at, { ...cur, state: 'unresolved' });
    await refreshOrder(tx, d, order.id);
    return true;
  });
  if (moved) await applyOneRead(d, order, po, read, 'poll');
}

/**
 * A PayPal order ends `declined` (not charged) only on the strict rule: condition 1 (it is waiting, and
 * none of its capture operations is `sent` or `unknown`, and no unit holds a capture id) checked again
 * under the order's locks, in this transaction; the caller has a fresh read that shows no capture (2a or
 * 2b). The capture gate takes the same lock, so a decline and a capture exclude each other.
 */
async function declinePo(
  d: PaymentsDeps,
  order_id: Id,
  po_id: Id,
  reason: string,
): Promise<boolean> {
  return d.db.transaction(async (tx) => {
    const at = nowIso(d);
    const graph = await lockGraph(tx, order_id);
    const po = poIn(graph, po_id);
    if (po.state !== 'approved' && po.state !== 'awaiting_buyer') return false;
    const live = await tx.query(
      `SELECT 1 FROM operations WHERE order_id = $1 AND kind = 'capture' AND provider_order_ref = $2
          AND state IN ('sent', 'unknown') LIMIT 1`,
      [order_id, po.id],
    );
    if (live.rows.length > 0) return false;
    const claimed = await tx.query(
      'SELECT 1 FROM order_units WHERE provider_order_ref = $1 AND capture_id IS NOT NULL LIMIT 1',
      [po.id],
    );
    if (claimed.rows.length > 0) return false;
    if (!(await setPoState(tx, po.id, 'declined', at, ['approved', 'awaiting_buyer'])))
      return false;
    await declineUnits(tx, d, order_id, reason, po);
    await tx.query(
      `UPDATE operations SET state = 'failed', failure_reason = 'declined', lease_until = NULL, next_retry_at = NULL, updated_at = $3
        WHERE order_id = $1 AND state = 'prepared' AND provider_order_ref = $2`,
      [order_id, po.id, at],
    );
    await refreshOrder(tx, d, order_id);
    await reissueReceipt(tx, d, order_id);
    return true;
  });
}

/** The fresh read of a waiting PayPal order does not match: only that PayPal order is held. */
async function holdPo(
  d: PaymentsDeps,
  order: OrderRow,
  po: ProviderOrderRow,
  bad: { field: string; unit: UnitRow | null }[],
): Promise<void> {
  await d.db.transaction(async (tx) => {
    await lockGraph(tx, order.id);
    const at = nowIso(d);
    if (!(await setPoState(tx, po.id, 'frozen', at, ['approved', 'awaiting_buyer']))) return;
    for (const b of bad) {
      if (b.unit !== null) {
        await tx.query(
          "UPDATE order_units SET status = 'mismatch', mismatch_reason = $2, updated_at = $3 WHERE id = $1 AND captured_verified_at IS NULL",
          [b.unit.id, b.field, at],
        );
      }
      await raiseOpsAlert(tx, d, {
        kind: 'frozen_order',
        order_id: order.id,
        unit_id: b.unit === null ? null : b.unit.id,
        reason:
          b.unit === null ? reasonFor(po, `precapture_${b.field}`) : `precapture_unit_${b.field}`,
        detail: { field: b.field, phase: 'continuation' },
      });
    }
    await tx.query(
      `UPDATE operations SET state = 'failed', failure_reason = 'mismatch', lease_until = NULL, next_retry_at = NULL, updated_at = $3
        WHERE order_id = $1 AND state = 'prepared' AND provider_order_ref = $2`,
      [order.id, po.id, at],
    );
    await refreshOrder(tx, d, order.id);
    await reissueReceipt(tx, d, order.id);
  });
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
