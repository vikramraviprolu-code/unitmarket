// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/due.ts (recoverOnStartup, P12) at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05b.
// Startup recovery: an operation that was `sent` (or `prepared` and part of a checkout that was
// moving) when the process died becomes `unknown`, due now. Nothing is sent from here: recovery
// starts with a read, because the due-work pass reads first and sends again only what the rules
// allow, with the original key, inside the 5 h window.
import type { PaymentsDeps } from '@umsbx/contracts';
import { isoOf } from './store';
import { markUnknown, runDue } from './due';

// A `prepared` operation is not in flight, with two exceptions: a create that never got to PayPal
// (its order is still `created`) and an operation of an order that is already past the buyer. A
// capture reopened for the buyer (`prepared`, order awaiting the buyer) waits for the buyer and is
// left alone (ASM-05B-1).
const IN_FLIGHT = `
  SELECT o.id, o.order_id, o.kind, o.state, o.first_sent_at, o.request_id
    FROM operations o JOIN orders r ON r.id = o.order_id
   WHERE o.state = 'sent'
      OR (o.state = 'prepared' AND (
            (o.kind = 'create' AND r.status = 'created')
         OR (o.kind IN ('capture', 'readback') AND r.status IN ('capture_requested', 'capture_claimed', 'unresolved'))))
   ORDER BY o.created_at, o.id`;

export async function recoverOnStartup(d: PaymentsDeps): Promise<{ resumed: number }> {
  const found = await d.db.query<Record<string, unknown>>(IN_FLIGHT);
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
  // Then one due-work pass: it reads first.
  await runDue(d, { max_items: 100 });
  return { resumed };
}
