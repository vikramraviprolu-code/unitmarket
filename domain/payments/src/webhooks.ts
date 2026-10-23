// Webhook intake (lane CO-2, ASM-60, ASM-63, nfr.md P1 and P2). A verified webhook is never evidence
// of payment. It becomes at most one stored event (idempotent on the event id and on the transmission
// id) and at most one due read-back for the order it names, and nothing else. It never sets paid,
// books the ledger, touches an entitlement, a window or a unit, or calls PayPal: the read-back
// decides, so the order in which events arrive does not matter. PAYMENT.CAPTURE.REVERSED is a hint
// only (ASM-63: PayPal signs a CRC32, so a body can be forged): it makes the read-back due and
// raises one alert; the unit changes only when a read shows the evidence (reconciler, observeReadback).
//
// Signature checks are not made here (lane CO-1 produces the verdict). The body is never stored or
// logged: the event keeps the ids that name its target and nothing else. Ids must be printable
// ASCII of 1 to 256 characters; any other delivery is `malformed` (400, one audit row, nothing
// stored), so a poison delivery is refused once instead of failing in the database and being
// retried for days.
//
// Cost: each distinct event costs one read-back per order, at most once per 60 s (COALESCE_MS), and
// only for an order somebody has captured (wantsReadback); an order still waiting for its buyer
// answers no_op (it used to start a 24 h poll, about 24 reads per event, ending in a false
// payment_unresolved alert). A read is a money-kind call under the BU-5 poll budget (money_only).
//
// The REVERSED hint is alert kind reversal_hint, which recovery keeps out of its case kinds: ops see
// it, no case opens and the buyer is told nothing until a read shows the evidence (kind reversal).
//
// Lock order (D-020): orders, then operations (lockOrderRows). Nothing here takes an order_units lock.
// The event insert is the first statement of the transaction: it holds a unique-index entry on
// (event_id, transmission_id) while the order locks are taken, so a concurrent duplicate waits for
// this transaction instead of racing it. Nothing writes webhook_events under a money lock in any
// other lane, and a future lane must not set applied_at inside a money transaction. The audit and
// alert rows are leaf inserts.
import { WebhookVerdictSchema } from '@umsbx/contracts';
import type {
  CoreDeps,
  Id,
  IsoUtc,
  OrderStatus,
  ProviderEvent,
  ProviderEventType,
  SqlExecutor,
  WebhookVerdict,
} from '@umsbx/contracts';
import { readbackKeyFor } from './keys';
import { raiseOpsAlert } from './refunds';
import { addMs, insertOperation, loadOperation, lockOrderRows } from './store';
import type { OperationRow, OrderRow } from './store';

export interface WebhookInput {
  verdict: WebhookVerdict;
  /** The delivery's transmission id, as received (hashed in the audit row of a refused delivery). */
  transmission_id: string;
  received_at: IsoUtc;
}
export interface WebhookResponse {
  http: 200 | 400 | 503;
  outcome: 'enqueued' | 'no_op' | 'duplicate' | 'rejected' | 'unverifiable' | 'disabled';
}

/** A read-back already due within this long is left alone (ASM-60). */
export const COALESCE_MS = 60_000;
const MAX_REASON = 200;

// ---------------------------------------------------------------------------------------------
// Pure rules

export type Target =
  | { by: 'capture_id'; key: string }
  | { by: 'refund_id'; key: string }
  | { by: 'provider_order_id'; key: string }
  | null;

const CAPTURE_EVENTS: ReadonlySet<ProviderEventType> = new Set<ProviderEventType>([
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
]);
const has = (v: string | null): v is string => v !== null && v !== '';

/**
 * The keys that name the order of an event, in the order they are tried. PAYMENT.CAPTURE.*: the
 * capture id (a refund resource carries its `up` link to the capture there), else the provider
 * refund id kept on refund_requests; then the provider order id, so a capture whose response was
 * lost (no capture id stored, C-12) is still found. CHECKOUT.ORDER.APPROVED and
 * CHECKOUT.PAYMENT-APPROVAL.REVERSED (a deviation from the spec's CHECKOUT.ORDER.*): the provider
 * order id only. Any other type names nothing.
 */
export function targetsOf(e: ProviderEvent): NonNullable<Target>[] {
  const order: NonNullable<Target>[] = has(e.provider_order_id)
    ? [{ by: 'provider_order_id', key: e.provider_order_id }]
    : [];
  if (CAPTURE_EVENTS.has(e.type)) {
    if (has(e.capture_id)) return [{ by: 'capture_id', key: e.capture_id }, ...order];
    if (has(e.refund_id)) return [{ by: 'refund_id', key: e.refund_id }, ...order];
    return order;
  }
  if (e.type === 'CHECKOUT.ORDER.APPROVED' || e.type === 'CHECKOUT.PAYMENT-APPROVAL.REVERSED') {
    return order;
  }
  return [];
}

// The charset of CO-1's ID_RE (packages/paypal webhook-verify): printable ASCII without space or pipe.
const PRINTABLE_ID = /^[\x21-\x7b\x7d-\x7e]{1,256}$/;
/** Every id of the event is printable ASCII (no space, no pipe, as CO-1) of 1 to 256 characters (null ids are absent, not empty). */
export function idsAreValid(e: ProviderEvent): boolean {
  return (
    PRINTABLE_ID.test(e.event_id) &&
    PRINTABLE_ID.test(e.transmission_id) &&
    [e.capture_id, e.refund_id, e.provider_order_id].every(
      (v) => v === null || PRINTABLE_ID.test(v),
    )
  );
}

const SETTLED_AWAY: ReadonlySet<OrderStatus> = new Set(['failed', 'abandoned', 'frozen']);
const CAPTURE_STARTED: ReadonlySet<OrderStatus> = new Set([
  'capture_requested',
  'capture_claimed',
  'unresolved',
  'paid',
  'paid_partial',
]);
/**
 * Only an order somebody has captured (or tried to capture) is woken. An order still waiting for
 * its buyer belongs to the buyer-return path and the abandonment sweep: a webhook-started read-back
 * there would poll for 24 h and end in a false payment_unresolved alert. Orders that are over
 * (failed, abandoned, frozen) are never read.
 */
export function wantsReadback(status: OrderStatus, hasCaptureOp: boolean): boolean {
  if (SETTLED_AWAY.has(status)) return false;
  return CAPTURE_STARTED.has(status) || hasCaptureOp;
}

export type ReadbackPlan = 'create' | 'reopen' | 'advance' | 'keep';

/**
 * What to do with the order's read-back operation so that it is due now, coalesced: an operation
 * that is unknown and already due within 60 s (or one in flight) is left alone; a later one is
 * brought forward; a settled one is opened again; none is created.
 */
export function planReadback(
  existing: Pick<OperationRow, 'state' | 'next_retry_at'> | null,
  now: string,
): ReadbackPlan {
  if (existing === null) return 'create';
  if (existing.state === 'confirmed' || existing.state === 'failed') return 'reopen';
  if (existing.state !== 'unknown') return 'keep';
  if (existing.next_retry_at === null) return 'advance';
  return Date.parse(existing.next_retry_at) <= Date.parse(now) + COALESCE_MS ? 'keep' : 'advance';
}

// ---------------------------------------------------------------------------------------------

async function findOrderId(tx: SqlExecutor, t: NonNullable<Target>): Promise<Id | null> {
  const sql =
    t.by === 'capture_id'
      ? 'SELECT order_id FROM order_units WHERE capture_id = $1'
      : t.by === 'refund_id'
        ? 'SELECT u.order_id FROM refund_requests r JOIN order_units u ON u.id = r.unit_id WHERE r.refund_id = $1'
        : 'SELECT order_id FROM provider_orders WHERE provider_order_id = $1';
  const found = await tx.query<{ order_id: string }>(sql, [t.key]);
  return found.rows[0]?.order_id ?? null;
}
async function findOrderOf(tx: SqlExecutor, targets: NonNullable<Target>[]): Promise<Id | null> {
  for (const t of targets) {
    const id = await findOrderId(tx, t);
    if (id !== null) return id;
  }
  return null;
}

/** Make the read-back due now, once. Returns 'coalesced' when nothing had to change. */
async function enqueueReadback(
  tx: SqlExecutor,
  d: CoreDeps,
  order: OrderRow,
  at: string,
): Promise<'enqueued' | 'coalesced'> {
  const existing = await loadOperation(tx, order.id, 'readback', { lock: true });
  const plan = planReadback(existing, at);
  if (plan === 'keep') return 'coalesced';
  if (plan === 'create' || existing === null) {
    await insertOperation(tx, {
      id: d.ids.next('opr'),
      order_id: order.id,
      kind: 'readback',
      state: 'unknown',
      request_id: readbackKeyFor(order.order_ref),
      lease_until: null,
      reconcile_until: addMs(at, d.config.reconcile_window_ms),
      next_retry_at: at,
      at,
    });
  } else if (plan === 'advance') {
    await tx.query(
      "UPDATE operations SET next_retry_at = $2, updated_at = $2 WHERE id = $1 AND state = 'unknown'",
      [existing.id, at],
    );
  } else {
    // A settled operation gets a fresh window: the event is new evidence that something moved.
    const until = addMs(at, d.config.reconcile_window_ms);
    await tx.query(
      `UPDATE operations SET state = 'unknown', failure_reason = NULL, lease_until = NULL,
         next_retry_at = $2, reconcile_until = $3, updated_at = $2
       WHERE id = $1 AND state IN ('confirmed', 'failed')`,
      [existing.id, at, until],
    );
  }
  return 'enqueued';
}

// sha256 of the UTF-8 bytes of a header value that is only ever hashed (never stored), computed by the
// database so that no node module is needed. It is passed as hex, so any content (NUL, lone
// surrogates) can be hashed. Ids that are stored are held to printable ASCII by idsAreValid.
async function sha256Hex(tx: SqlExecutor, text: string): Promise<string> {
  const hex = Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0'));
  const found = await tx.query<{ h: string }>(
    "SELECT encode(sha256(decode($1, 'hex')), 'hex') AS h",
    [hex.join('')],
  );
  return found.rows[0]?.h ?? '';
}

async function refuse(
  d: CoreDeps,
  i: WebhookInput,
  kind: 'bad_signature' | 'malformed' | 'unverifiable',
  reason: string,
): Promise<void> {
  await d.db.transaction(async (tx) => {
    await d.audit.record(tx, {
      actor: { kind: 'system' },
      action: kind === 'unverifiable' ? 'webhook.unverifiable' : 'webhook.rejected',
      target: null,
      reason: reason.slice(0, MAX_REASON),
      detail: { verdict: kind, transmission_sha256: await sha256Hex(tx, i.transmission_id) },
    });
  });
}

async function intake(d: CoreDeps, i: WebhookInput, e: ProviderEvent): Promise<WebhookResponse> {
  return d.db.transaction(async (tx): Promise<WebhookResponse> => {
    const at = d.clock.now().toISOString();
    const targets = targetsOf(e);
    // Idempotency on the event id and on the transmission id: a conflict on either changes nothing.
    const stored = await tx.query(
      `INSERT INTO webhook_events (id, event_id, transmission_id, type, verified, outcome, resource,
         received_at, applied_at, environment, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, NULL, $5::jsonb, $6, NULL, $7, $8, $8)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        d.ids.next('whk'),
        e.event_id,
        e.transmission_id,
        e.type,
        JSON.stringify({
          capture_id: e.capture_id,
          refund_id: e.refund_id,
          provider_order_id: e.provider_order_id,
          occurred_at: e.occurred_at,
        }),
        i.received_at,
        d.environment,
        at,
      ],
    );
    const row = stored.rows[0] as { id: string } | undefined;
    if (row === undefined) return { http: 200, outcome: 'duplicate' };

    const order_id = await findOrderOf(tx, targets);
    const order = order_id === null ? null : await lockOrderRows(tx, order_id);
    let outcome: 'enqueued' | 'coalesced' | 'no_op' = 'no_op';
    const captured =
      order !== null &&
      wantsReadback(
        order.status,
        (
          await tx.query(
            "SELECT 1 FROM operations WHERE order_id = $1 AND kind = 'capture' LIMIT 1",
            [order.id],
          )
        ).rows.length > 0,
      );
    if (order !== null && captured) {
      outcome = await enqueueReadback(tx, d, order, at);
      // A reversal is a hint (ASM-63): one alert for a human, the unit is not touched. Only a read
      // that shows the evidence moves it. The alert is unique per kind, order, unit and reason.
      if (e.type === 'PAYMENT.CAPTURE.REVERSED') {
        const unit =
          e.capture_id === null
            ? undefined
            : (
                await tx.query<{ id: string }>(
                  'SELECT id FROM order_units WHERE capture_id = $1 AND order_id = $2',
                  [e.capture_id, order.id],
                )
              ).rows[0];
        await raiseOpsAlert(tx, d, {
          kind: 'reversal_hint',
          order_id: order.id,
          unit_id: unit?.id ?? null,
          reason: 'reversal_hint',
          detail: { source: 'webhook', capture_id: e.capture_id },
        });
      }
    }
    await tx.query('UPDATE webhook_events SET outcome = $2, updated_at = $3 WHERE id = $1', [
      row.id,
      outcome,
      at,
    ]);
    return { http: 200, outcome: outcome === 'no_op' ? 'no_op' : 'enqueued' };
  });
}

/**
 * One delivery, after verification (CO-1). `webhook_enabled` off answers 503 and stores nothing
 * (PayPal retries). A refused verdict leaves one audit row with the reason and a hash of the
 * transmission id, never the body. A verified event is stored once and makes the read-back due.
 */
export async function handleWebhook(d: CoreDeps, i: WebhookInput): Promise<WebhookResponse> {
  // Outside any transaction: the switch reader may use the database itself.
  if (!(await d.switches.isOn('webhook_enabled'))) return { http: 503, outcome: 'disabled' };
  const v = i.verdict;
  switch (v.kind) {
    case 'bad_signature':
      await refuse(d, i, 'bad_signature', v.why);
      return { http: 400, outcome: 'rejected' };
    case 'malformed':
      await refuse(d, i, 'malformed', 'malformed');
      return { http: 400, outcome: 'rejected' };
    case 'unverifiable':
      await refuse(d, i, 'unverifiable', 'unverifiable');
      return { http: 503, outcome: 'unverifiable' };
    case 'verified': {
      // The verifier already parsed the verdict; a delivery that does not fit the contract or whose
      // ids the database could not hold faithfully is refused once, never thrown at.
      const parsed = WebhookVerdictSchema.safeParse(v);
      if (!parsed.success || parsed.data.kind !== 'verified' || !idsAreValid(parsed.data.event)) {
        await refuse(d, i, 'malformed', 'invalid_ids');
        return { http: 400, outcome: 'rejected' };
      }
      return intake(d, i, parsed.data.event);
    }
  }
}
