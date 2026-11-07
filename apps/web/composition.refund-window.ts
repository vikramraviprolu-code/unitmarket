// BR-4: the composition module that reads the refund deadline for the web app. It is the one place in the web
// app that touches @umsbx/rules (Z1): pages and routes get a RefundWindowView through the engine and never
// compute a date. The deadline is the access start (else the verified capture) plus the refund window frozen
// in the sale's approval snapshot; the words for it are in src/lib/buyer-copy.ts.
import { judgedAt, unitRefundWindows } from '@umsbx/rules';
import type { UnitRefundWindow } from '@umsbx/rules';
import { IdSchema } from '@umsbx/contracts';
import type { Actor, Database, Id } from '@umsbx/contracts';
import { refundWindowView } from './src/lib/buyer-copy';
import type { RefundWindowView } from './src/lib/buyer-copy';

// The operator's panel judges the window as requestRefund does: at the buyer's refund case when there is one.
// Past the deadline with a case opened in time, the panel says so and asks for no override reason.
const viewOf = (w: UnitRefundWindow, now: string): RefundWindowView => {
  if (w.unreadable) return { state: 'unknown' };
  const asked = refundWindowView(w.deadline, judgedAt(w, now));
  const today = refundWindowView(w.deadline, now);
  if (asked.state === 'open' && today.state === 'ended') {
    return { state: 'asked_in_time', deadline: asked.deadline };
  }
  return asked;
};

/** The window of each captured unit, by unit id (the operator's refund list). A unit not listed has none. */
export async function refundWindowsOfUnits(
  db: Database,
  now: string,
  unit_ids: string[],
): Promise<Map<string, RefundWindowView>> {
  const out = new Map<string, RefundWindowView>();
  if (unit_ids.length === 0) return out;
  for (const w of await unitRefundWindows(db, { unit_ids })) out.set(w.unit_id, viewOf(w, now));
  return out;
}

/**
 * The buyer's own item or order. Another buyer's, an unknown id, and any actor but a buyer answer null, as
 * the other buyer reads do. With several units (an order of two items) the latest deadline is shown; a sale
 * with no deadline shows none, and one whose terms cannot be read shows no date.
 */
export async function buyerRefundWindow(
  db: Database,
  now: string,
  i: { actor: Actor; entitlement_id?: Id; order_id?: Id },
): Promise<RefundWindowView | null> {
  if (i.actor.kind !== 'buyer') return null;
  const target = i.entitlement_id ?? i.order_id;
  if (target === undefined || !IdSchema.safeParse(target).success) return null;
  const owner =
    i.entitlement_id !== undefined
      ? (
          await db.query<{ buyer_id: string }>('SELECT buyer_id FROM entitlements WHERE id = $1', [
            i.entitlement_id,
          ])
        ).rows[0]
      : i.order_id !== undefined
        ? (
            await db.query<{ buyer_id: string }>('SELECT buyer_id FROM orders WHERE id = $1', [
              i.order_id,
            ])
          ).rows[0]
        : undefined;
  if (owner === undefined || owner.buyer_id !== i.actor.buyer_id) return null;
  const windows = await unitRefundWindows(
    db,
    i.entitlement_id !== undefined
      ? { entitlement_id: i.entitlement_id }
      : { order_id: i.order_id as Id },
  );
  if (windows.length === 0) return { state: 'none' };
  if (windows.some((w) => w.unreadable)) return { state: 'unknown' };
  if (windows.some((w) => w.deadline === null)) return { state: 'none' };
  const latest = windows.map((w) => w.deadline as string).sort()[windows.length - 1] as string;
  return refundWindowView(latest, now);
}
