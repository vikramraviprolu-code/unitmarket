import { err, ok } from '@umsbx/contracts';
import type {
  Actor,
  AuditSink,
  Clock,
  Database,
  Result,
  SwitchName,
  SwitchReader,
} from '@umsbx/contracts';

export const MAX_SWITCH_CACHE_MS = 5000;

// Reads `safety_switches` per request through a cache no older than 5 s (architecture 7.4,
// RLR-3). A missing row or a failed read counts as off: the safe state for every switch.
export function createSwitchReader(
  db: Database,
  clock: Clock,
  cache_ms: number = MAX_SWITCH_CACHE_MS,
): SwitchReader {
  const ttl = Math.max(0, Math.min(cache_ms, MAX_SWITCH_CACHE_MS));
  const cache = new Map<SwitchName, { on: boolean; at: number }>();
  return {
    async isOn(name) {
      const now = clock.now().getTime();
      const hit = cache.get(name);
      if (hit !== undefined && now >= hit.at && now - hit.at < ttl) return hit.on;
      let on = false;
      try {
        const r = await db.query<{ on: boolean }>(
          'SELECT "on" FROM safety_switches WHERE name = $1',
          [name],
        );
        on = r.rows[0]?.on === true;
      } catch {
        on = false;
      }
      cache.set(name, { on, at: now });
      return on;
    },
  };
}

function actorLabel(a: Actor): string {
  switch (a.kind) {
    case 'buyer':
      return `buyer:${a.buyer_id}`;
    case 'publisher':
      return `publisher:${a.publisher_id}`;
    case 'operator':
      return `operator:${a.operator_id}`;
    case 'system':
      return 'system';
  }
}

// Changes a switch and writes the audit row in one transaction. Turning paypal_outbound on needs
// the approval ref of the owner's written approval (architecture 7.4).
export async function setSwitch(
  db: Database,
  audit: AuditSink,
  clock: Clock,
  i: { name: SwitchName; on: boolean; by: Actor; reason: string; approval_ref: string | null },
): Promise<Result<void, 'reason_required' | 'approval_ref_required'>> {
  const reason = i.reason.trim();
  if (reason === '') return err('reason_required');
  const ref = i.approval_ref === null ? null : i.approval_ref.trim();
  if (i.name === 'paypal_outbound' && i.on && (ref === null || ref === '')) {
    return err('approval_ref_required');
  }
  const at = clock.now().toISOString();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE safety_switches SET "on" = $2, changed_by = $3, changed_at = $4, reason = $5, updated_at = $4 WHERE name = $1`,
      [i.name, i.on, actorLabel(i.by), at, reason],
    );
    await audit.record(tx, {
      actor: i.by,
      action: `switch.${i.name}.${i.on ? 'on' : 'off'}`,
      target: null,
      reason,
      detail: { switch: i.name, on: i.on, approval_ref: ref },
    });
  });
  return ok(undefined);
}
