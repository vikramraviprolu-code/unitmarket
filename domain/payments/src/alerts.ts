// Alerts for a human. Written here, with one exception: recovery writes the refund_failed alert of a
// refund_pending case that went back to diagnosing (domain/recovery/src/cases.ts, settleRefundCase)
// with the same row shape and the same unique index, because payments is never imported by recovery.
// One alert of a kind per order, unit and reason (the reason is detail.reason, a short code): the insert ignores a duplicate, so a repeated read of the
// same problem raises nothing new, while a different problem of the same kind is its own alert. INT-AL: a duplicate
// of an alert that was resolved reopens it (alert_events, kind reopened), and nothing else about raising changed.
// Lane 10 opens recovery cases from these rows; payments never imports recovery.
import type { CoreDeps, Id, SqlExecutor } from '@umsbx/contracts';

export type AlertKind =
  | 'frozen_order'
  | 'create_rejected'
  | 'content_unavailable'
  | 'unexpected_capture'
  | 'fee_above_amount'
  | 'payment_unresolved'
  | 'reversal'
  // A PAYMENT.CAPTURE.REVERSED webhook, unproven until a read shows it (ASM-63). Ops see it; recovery
  // keeps it out of ALERT_CASE_KINDS, so no case opens and the buyer is told nothing.
  | 'reversal_hint'
  // MVP-D: a pack ended paid_partial with at least one PayPal order not charged (declined, failed or
  // abandoned). Once per order, reason `partial`. A frozen PayPal order is on hold and never raises it.
  | 'partial_composite'
  | 'refund_unbooked'
  | 'refund_failed'
  | 'refund_unresolved'
  // POB-M1: a refund was booked after the publisher's share of that sale was paid out (a payout_adjustment row, taken
  // off the next payout), and a payout the provider refused.
  | 'payout_adjustment'
  | 'payout_failed'
  // INT-AL: raised by the alert sweep (domain/alerts), not by a payment: the entity is in the reason (the
  // mandate id, the subscription id), so these two have no order.
  | 'mandate_near_cap'
  | 'webhook_failing';

export async function raiseAlert(
  tx: SqlExecutor,
  d: Pick<CoreDeps, 'clock' | 'ids'>,
  i: {
    kind: AlertKind;
    /** Null for an alert about something that is not an order (a mandate, a webhook subscription). */
    order_id: Id | null;
    unit_id: Id | null;
    reason: string;
    detail?: Record<string, string | number | boolean | null>;
  },
): Promise<AlertKind | null> {
  const at = d.clock.now().toISOString();
  const inserted = await tx.query(
    `INSERT INTO alerts (id, kind, order_id, unit_id, detail, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6) ON CONFLICT DO NOTHING RETURNING id`,
    [
      d.ids.next('alr'),
      i.kind,
      i.order_id,
      i.unit_id,
      JSON.stringify({ ...(i.detail ?? {}), reason: i.reason }),
      at,
    ],
  );
  if (inserted.rows.length > 0) return i.kind;
  // INT-AL: the same problem seen again. When an operator or the sweep had resolved the alert, it is open
  // again: one `reopened` event, by whoever is writing (a job pass is `system`). An alert that is still open
  // or only acknowledged is left as it is. A null order or unit is the same key, not a new one.
  const latest = await tx.query<{ id: string; state: string | null }>(
    `SELECT a.id,
            (SELECT e.kind FROM alert_events e WHERE e.alert_id = a.id ORDER BY e.seq DESC LIMIT 1) AS state
       FROM alerts a
      WHERE a.kind = $1 AND a.order_id IS NOT DISTINCT FROM $2 AND a.unit_id IS NOT DISTINCT FROM $3
        AND a.detail ->> 'reason' = $4`,
    [i.kind, i.order_id, i.unit_id, i.reason],
  );
  const row = latest.rows[0];
  if (row === undefined || (row.state !== 'resolved' && row.state !== 'auto_resolved')) return null;
  await tx.query(
    `INSERT INTO alert_events (id, alert_id, kind, reason_code, note_sha256, at, created_at, updated_at)
     VALUES ($1, $2, 'reopened', NULL, NULL, $3, $3, $3)`,
    [d.ids.next('ale'), row.id, at],
  );
  return i.kind;
}
