// BR-4: reads the refund deadline of the units of a sale from the database. The terms come from the sale's
// approval snapshot (frozen, BR-3), the start from the access window (else the verified capture). Payments
// (the operator's refund) and recovery (the buyer's refund case) both read it here, so they cannot disagree.
// Only units with a verified capture are listed: an unpaid unit has no refund window.
import type { SqlExecutor } from '@umsbx/contracts';
import { readSnapshotTerms, refundDeadline } from './deadline';

export interface UnitRefundWindow {
  readonly unit_id: string;
  /** True when the snapshot's terms cannot be read: callers treat the window as closed, never as "no deadline". */
  readonly unreadable: boolean;
  /** The ISO time the window closes; null for a version 1 sale (no deadline) and for an unreadable one. */
  readonly deadline: string | null;
  /**
   * The creation time of the buyer's earliest unsettled refund_requested case for the unit, or null. The window
   * is judged at this time when there is one, so a buyer who asked in time is honoured however late the
   * operator acts. Payments and the operator's refund panel both read it here, so they cannot disagree.
   */
  readonly asked_at: string | null;
}

/** The time the window is judged at: the buyer's case when there is one, else `now`. */
export function judgedAt(w: Pick<UnitRefundWindow, 'asked_at'>, now: string): string {
  return w.asked_at ?? now;
}

export type UnitFilter =
  | { readonly unit_id: string }
  | { readonly unit_ids: readonly string[] }
  | { readonly order_id: string }
  | { readonly entitlement_id: string };

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

export async function unitRefundWindows(
  tx: SqlExecutor,
  filter: UnitFilter,
): Promise<UnitRefundWindow[]> {
  const [where, value] =
    'unit_id' in filter
      ? (['u.id = $1', filter.unit_id] as const)
      : 'unit_ids' in filter
        ? (['u.id::text = ANY($1::text[])', [...filter.unit_ids]] as const)
        : 'order_id' in filter
          ? (['u.order_id = $1', filter.order_id] as const)
          : (['e.id = $1', filter.entitlement_id] as const);
  const rows = await tx.query<{
    unit_id: string;
    snapshot: unknown;
    started_at: Date | string | null;
    captured: Date | string;
    asked: Date | string | null;
  }>(
    `SELECT u.id AS unit_id, a.snapshot, w.started_at, u.captured_verified_at AS captured,
            (SELECT min(c.created_at) FROM recovery_cases c
              WHERE c.kind = 'refund_requested' AND c.state IN ('open', 'diagnosing', 'refund_pending')
                AND ((c.entitlement_id IS NOT NULL
                      AND c.entitlement_id IN (SELECT id FROM entitlements WHERE unit_id = u.id))
                  OR (c.entitlement_id IS NULL AND c.order_id = u.order_id))) AS asked
       FROM order_units u
       JOIN orders o ON o.id = u.order_id
       JOIN approvals a ON a.id = o.approval_id
       LEFT JOIN entitlements e ON e.unit_id = u.id
       LEFT JOIN access_windows w ON w.entitlement_id = e.id
      WHERE ${where} AND u.captured_verified_at IS NOT NULL
      ORDER BY u.id, e.id`,
    [value],
  );
  const seen = new Set<string>();
  const out: UnitRefundWindow[] = [];
  for (const r of rows.rows) {
    if (seen.has(r.unit_id)) continue;
    seen.add(r.unit_id);
    const asked_at = r.asked === null ? null : iso(r.asked);
    const read = readSnapshotTerms(r.snapshot);
    if (read.kind === 'invalid') {
      out.push({ unit_id: r.unit_id, unreadable: true, deadline: null, asked_at });
      continue;
    }
    out.push({
      unit_id: r.unit_id,
      unreadable: false,
      asked_at,
      deadline: refundDeadline({
        terms: read.kind === 'v2' ? read.terms : null,
        access_started_at: r.started_at === null ? null : iso(r.started_at),
        captured_verified_at: iso(r.captured),
      }),
    });
  }
  return out;
}
