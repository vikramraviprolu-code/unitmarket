// Webhook intake (lane CO-2, ASM-60, nfr.md P1 and P2). A verified webhook is never evidence of
// payment. It becomes at most one stored event (idempotent on the event id and on the transmission
// id) and at most one due read-back for the order it names, and nothing else, apart from marking a
// suspected reversal. It never sets paid, books the ledger, touches an entitlement or a window, or
// calls PayPal: the read-back decides, so the order in which events arrive does not matter.
//
// Signature checks are not made here (lane CO-1 produces the verdict). The body is never stored or
// logged: the event keeps the ids that name its target and nothing else.
//
// Lock order (D-020): orders, then operations (lockOrderRows), then order_units (suspectReversalTx).
// The event row and the audit row are leaf inserts.
import type {
  CoreDeps,
  Id,
  IsoUtc,
  ProviderEvent,
  ProviderEventType,
  SqlExecutor,
  WebhookVerdict,
} from '@umsbx/contracts';
import { readbackKeyFor } from './keys';
import { suspectReversalTx } from './refunds';
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
 * The key that names the order of an event. PAYMENT.CAPTURE.* by capture id (a refund resource
 * carries its `up` link to the capture there), else by the provider refund id kept on
 * refund_requests; CHECKOUT.ORDER.APPROVED by provider order id. Any other type names nothing.
 */
export function targetOf(e: ProviderEvent): Target {
  if (CAPTURE_EVENTS.has(e.type)) {
    if (has(e.capture_id)) return { by: 'capture_id', key: e.capture_id };
    if (has(e.refund_id)) return { by: 'refund_id', key: e.refund_id };
    return null;
  }
  if (e.type === 'CHECKOUT.ORDER.APPROVED' && has(e.provider_order_id)) {
    return { by: 'provider_order_id', key: e.provider_order_id };
  }
  return null;
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

// sha256 of the UTF-8 bytes, computed by the database so that no node module is needed. The id is
// passed as hex, so any content (NUL, lone surrogates) is hashed instead of refused.
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
    const target = targetOf(e);
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

    const order_id = target === null ? null : await findOrderId(tx, target);
    const order = order_id === null ? null : await lockOrderRows(tx, order_id);
    let outcome: 'enqueued' | 'coalesced' | 'no_op' = 'no_op';
    if (order !== null) {
      outcome = await enqueueReadback(tx, d, order, at);
      // Operations were locked first; the unit is locked inside (D-020).
      if (e.type === 'PAYMENT.CAPTURE.REVERSED' && target?.by === 'capture_id') {
        await suspectReversalTx(tx, d, { capture_id: target.key, source: 'webhook' });
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
    case 'verified':
      return intake(d, i, v.event);
  }
}
