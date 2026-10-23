// Alerts for a human. Written here, with one exception: recovery writes the refund_failed alert of a
// refund_pending case that went back to diagnosing (domain/recovery/src/cases.ts, settleRefundCase)
// with the same row shape and the same unique index, because payments is never imported by recovery.
// One alert of a kind per order, unit and reason (the reason is detail.reason, a short code): the insert ignores a duplicate, so a repeated read of the
// same problem raises nothing new, while a different problem of the same kind is its own alert.
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
  | 'refund_unbooked'
  | 'refund_failed'
  | 'refund_unresolved';

export async function raiseAlert(
  tx: SqlExecutor,
  d: Pick<CoreDeps, 'clock' | 'ids'>,
  i: {
    kind: AlertKind;
    order_id: Id;
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
  return inserted.rows.length > 0 ? i.kind : null;
}
