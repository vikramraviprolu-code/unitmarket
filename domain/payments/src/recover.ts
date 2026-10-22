// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/due.ts (recoverOnStartup, P12) at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05b.
// Startup recovery: an operation that was `sent` (or `prepared` and part of a checkout that was
// moving) when the process died becomes `unknown`, due now. Nothing is sent from here: recovery
// starts with a read, because the due-work pass reads first and sends again only what the rules
// allow, with the original key, inside the 5 h window.
import type { PaymentsDeps } from '@umsbx/contracts';
import { ensureReadbackOp } from './apply';
import { requestIdFor } from './keys';
import { ensureRefundReadbackOp } from './refunds';
import { isoOf, loadOperationByRequestId, lockOrderRows } from './store';
import { markUnknown, runDue } from './due';

// A `prepared` operation is not in flight, with two exceptions: a create that never got to PayPal
// (its order is still `created`) and an operation of an order that is already past the buyer. A
// capture reopened for the buyer (`prepared`, order awaiting the buyer) waits for the buyer and is
// left alone (ASM-05B-1). An operation whose lease is still running belongs to a live process (or
// to one that died a moment ago): it is left alone, the sweeper takes it when the lease runs out
// (FIX-PAY2 LOW; nextDueAt wakes the loop at that time).
const IN_FLIGHT = `
  SELECT o.id, o.order_id, o.kind, o.state, o.first_sent_at, o.request_id
    FROM operations o JOIN orders r ON r.id = o.order_id
   WHERE (o.lease_until IS NULL OR o.lease_until <= $1)
     AND (o.state = 'sent'
      OR (o.state = 'prepared' AND (
            (o.kind = 'create' AND r.status = 'created')
         OR (o.kind IN ('capture', 'readback') AND r.status IN ('capture_requested', 'capture_claimed', 'unresolved')))))
   ORDER BY o.created_at, o.id`;

// INV5 and INV6 as repairs: an order in flight with nothing polling it gets a read-back operation,
// an open (pending) refund with nothing polling it gets a refund read-back operation. Both are the
// states an older build could leave behind after a crash (H-1, H-2).
const UNPOLLED_ORDERS = `
  SELECT o.id FROM orders o
   WHERE o.status IN ('capture_requested', 'capture_claimed', 'unresolved')
     AND NOT EXISTS (SELECT 1 FROM operations p WHERE p.order_id = o.id AND p.state IN ('sent', 'unknown'))
     AND NOT EXISTS (SELECT 1 FROM operations p WHERE p.order_id = o.id
                       AND p.kind IN ('create', 'capture', 'readback')
                       AND p.state = 'failed' AND p.failure_reason = 'window_expired')
   ORDER BY o.id`;
const UNPOLLED_REFUNDS = `
  SELECT r.id, u.order_id FROM refund_requests r JOIN order_units u ON u.id = r.unit_id
   WHERE r.state = 'pending'
     AND NOT EXISTS (SELECT 1 FROM operations p
                      WHERE p.request_id IN ('umsR-' || r.id, 'umsRB-' || r.id) AND p.state IN ('sent', 'unknown'))
   ORDER BY r.id`;

async function repairUnpolled(d: PaymentsDeps): Promise<number> {
  let repaired = 0;
  const orders = await d.db.query<{ id: string }>(UNPOLLED_ORDERS);
  for (const { id } of orders.rows) {
    await d.db.transaction(async (tx) => {
      const order = await lockOrderRows(tx, id);
      if (order === null) return;
      await ensureReadbackOp(tx, d, order, d.clock.now().toISOString());
    });
    repaired += 1;
  }
  const refunds = await d.db.query<{ id: string; order_id: string }>(UNPOLLED_REFUNDS);
  for (const r of refunds.rows) {
    await d.db.transaction(async (tx) => {
      await lockOrderRows(tx, r.order_id);
      const at = d.clock.now().toISOString();
      const sent = await loadOperationByRequestId(tx, requestIdFor('refund', r.id));
      await ensureRefundReadbackOp(tx, d, r.id, r.order_id, sent?.first_sent_at ?? at, at);
    });
    repaired += 1;
  }
  return repaired;
}

export async function recoverOnStartup(
  d: PaymentsDeps,
): Promise<{ resumed: number; repaired: number }> {
  const found = await d.db.query<Record<string, unknown>>(IN_FLIGHT, [d.clock.now().toISOString()]);
  let resumed = 0;
  for (const r of found.rows) {
    const moved = await d.db.transaction((tx) =>
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
        r['state'] as 'sent' | 'prepared',
      ),
    );
    if (moved) resumed += 1;
  }
  const repaired = await repairUnpolled(d);
  // Then one due-work pass: it reads first.
  await runDue(d, { max_items: 100 });
  return { resumed, repaired };
}
