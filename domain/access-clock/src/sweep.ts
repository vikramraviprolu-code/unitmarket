// Ends windows whose time is up and records window_ended once per window (REL-4: running it
// twice changes nothing the second time).
import type { CoreDeps } from '@umsbx/contracts';
import { computeWindow } from './compute';
import { insertEvent, loadEvents, lockEntitlement, materialise } from './events';

export async function sweepWindows(
  d: CoreDeps,
  i: { max_items: number },
): Promise<{ ended: number }> {
  if (!Number.isInteger(i.max_items) || i.max_items <= 0) return { ended: 0 };
  return d.db.transaction(async (tx) => {
    const now = d.clock.now();
    const due = await tx.query<{ entitlement_id: string }>(
      `SELECT w.entitlement_id FROM access_windows w
       WHERE w.state IN ('running', 'ended') AND w.ends_at <= $1
         AND NOT EXISTS (SELECT 1 FROM access_events e WHERE e.entitlement_id = w.entitlement_id AND e.kind = 'window_ended')
       ORDER BY w.ends_at, w.entitlement_id LIMIT $2 FOR UPDATE OF w SKIP LOCKED`,
      [now.toISOString(), i.max_items],
    );
    let ended = 0;
    for (const row of due.rows) {
      const head = await lockEntitlement(tx, row.entitlement_id);
      if (head === null) continue;
      const window = computeWindow(await loadEvents(tx, head.id), head.policy, now);
      if (window.state !== 'ended' || window.ends_at === null) continue;
      await insertEvent(tx, d, {
        entitlement_id: head.id,
        kind: 'window_ended',
        link_id: null,
        source: 'system',
        evidence: { ends_at: window.ends_at },
        at: new Date(window.ends_at),
      });
      await materialise(tx, d, head);
      ended += 1;
    }
    return { ended };
  });
}
