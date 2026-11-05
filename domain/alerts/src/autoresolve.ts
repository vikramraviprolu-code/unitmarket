// INT-AL / AL.4: the sweep that resolves an alert when its condition has cleared. It runs in the job loop, under
// the job-pass trace context (system, channel job), and writes `auto_resolved` once per alert whose rule holds.
// Only the rules of the table below resolve anything; every other kind, and a refund that PayPal paid out but the
// ledger did not book, stays open until a person resolves it. A rule never needs the network: it reads rows.
//
//   payment_unresolved, frozen_order   the order is paid, paid_partial, failed or abandoned (the terminal order
//                                      states; an order has no `refunded` status)
//   refund_unresolved                  only refund_outcome_unknown_<rq>: request <rq> is completed AND a ledger
//                                      row of kind refund with that refund_id exists
//   refund_failed                      a later request for the same unit is completed with its ledger row
//   mandate_near_cap                   the mandate is revoked, expired or exhausted
//   webhook_failing                    the subscription's latest delivery is delivered
import type { CoreDeps } from '@umsbx/contracts';
import { NOT_RESOLVED, appendEvent } from './state';

type Deps = Pick<CoreDeps, 'db' | 'clock' | 'ids'>;

const REASON = "(a.detail ->> 'reason')";
const BOOKED = (refundId: string): string =>
  `(${refundId} IS NOT NULL AND EXISTS (SELECT 1 FROM ledger_entries l WHERE l.kind = 'refund' AND l.refund_id = ${refundId}))`;

/** Each rule is one SELECT of alert ids; `$1` is the time of the pass. */
const RULES: readonly { name: string; sql: string }[] = [
  {
    name: 'order_settled',
    sql: `SELECT a.id FROM alerts a
            JOIN order_units u ON u.id = a.unit_id
            JOIN orders o ON o.id = COALESCE(a.order_id, u.order_id)
           WHERE a.kind IN ('payment_unresolved', 'frozen_order') AND ${NOT_RESOLVED}
             AND o.status IN ('paid', 'paid_partial', 'failed', 'abandoned')
          UNION
          SELECT a.id FROM alerts a
            JOIN orders o ON o.id = a.order_id
           WHERE a.kind IN ('payment_unresolved', 'frozen_order') AND a.unit_id IS NULL AND ${NOT_RESOLVED}
             AND o.status IN ('paid', 'paid_partial', 'failed', 'abandoned')`,
  },
  {
    name: 'refund_outcome_known',
    sql: `SELECT a.id FROM alerts a
            JOIN refund_requests r ON r.id = substring(${REASON} from '^refund_outcome_unknown_(.+)$')
           WHERE a.kind = 'refund_unresolved' AND ${NOT_RESOLVED}
             AND r.state = 'completed' AND ${BOOKED('r.refund_id')}`,
  },
  {
    name: 'refund_retried',
    sql: `SELECT a.id FROM alerts a
            LEFT JOIN refund_requests f ON f.id = (a.detail ->> 'refund_request_id')
           WHERE a.kind = 'refund_failed' AND a.unit_id IS NOT NULL AND ${NOT_RESOLVED}
             AND EXISTS (SELECT 1 FROM refund_requests r
                          WHERE r.unit_id = a.unit_id AND r.state = 'completed'
                            AND r.created_at > COALESCE(f.created_at, a.created_at)
                            AND ${BOOKED('r.refund_id')})`,
  },
  {
    name: 'mandate_finished',
    sql: `SELECT a.id FROM alerts a
            JOIN mandates m ON m.id = substring(${REASON} from '^cap90_(.+)$')
           WHERE a.kind = 'mandate_near_cap' AND ${NOT_RESOLVED}
             AND (m.revoked_at IS NOT NULL OR m.exhausted_at IS NOT NULL OR m.expires_at <= $1::timestamptz)`,
  },
  {
    name: 'webhook_recovered',
    sql: `SELECT a.id FROM alerts a
           WHERE a.kind = 'webhook_failing' AND ${NOT_RESOLVED}
             AND (SELECT w.status FROM webhook_deliveries w
                   WHERE w.subscription_id = substring(${REASON} from '^webhook_failing_(wsb_[0-9a-z]+)_wdl_[0-9a-z]+$')
                   ORDER BY w.created_at DESC, w.id DESC LIMIT 1) = 'delivered'`,
  },
];

/** Resolves every alert whose rule holds, once. Returns how many it resolved. */
export async function autoResolve(d: Deps): Promise<{ resolved: number }> {
  return d.db.transaction(async (tx) => {
    const now = d.clock.now().toISOString();
    const done = new Set<string>();
    for (const rule of RULES) {
      const r = await tx.query<{ id: string }>(rule.sql, rule.sql.includes('$1') ? [now] : []);
      for (const row of r.rows) {
        if (done.has(row.id)) continue;
        done.add(row.id);
        await appendEvent(tx, d, { alert_id: row.id, kind: 'auto_resolved' });
      }
    }
    return { resolved: done.size };
  });
}
