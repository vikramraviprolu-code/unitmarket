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
export type SetSwitchError =
  | 'reason_required'
  | 'approval_ref_required'
  | 'operator_required'
  | 'approval_not_active'
  | 'already_on'
  | 'switch_changed';

// Review 4 M10: only an operator changes a switch. Turning paypal_outbound ON also needs MFA and an
// outbound_approvals row that is active (valid_until after now) for the given ref; the row is
// checked in the same transaction as the update. Turning anything OFF needs only the operator.
export async function setSwitch(
  db: Database,
  audit: AuditSink,
  clock: Clock,
  i: {
    name: SwitchName;
    on: boolean;
    by: Actor;
    reason: string;
    approval_ref: string | null;
    /** A second audit row, written in the same transaction (the resume check records `safety.resume`). */
    also_audit?: {
      action: 'safety.resume';
      target: string | null;
      detail: Record<string, string | number | boolean | null>;
    };
    /**
     * The resume check (WEB-OPS-START): inside the transaction, with the switch row locked, refuse when
     * it is already on (`refuse_if_on`) or when it changed since `seen_changed_at` was read (a Stop or
     * another Start committed in between).
     */
    resume_guard?: { refuse_if_on: boolean; seen_changed_at: string };
  },
): Promise<Result<void, SetSwitchError>> {
  const reason = i.reason.trim();
  if (reason === '') return err('reason_required');
  if (i.by.kind !== 'operator') return err('operator_required');
  const ref = i.approval_ref === null ? null : i.approval_ref.trim();
  const needsApproval = i.name === 'paypal_outbound' && i.on;
  if (needsApproval && (ref === null || ref === '')) {
    return err('approval_ref_required');
  }
  if (needsApproval && !i.by.mfa) return err('operator_required');
  const at = clock.now().toISOString();
  const refused = await db.transaction(async (tx): Promise<SetSwitchError | null> => {
    if (needsApproval) {
      const active = await tx.query(
        'SELECT 1 FROM outbound_approvals WHERE approval_ref = $1 AND valid_until > $2 FOR UPDATE',
        [ref, at],
      );
      if (active.rows.length === 0) return 'approval_not_active';
    }
    if (i.resume_guard !== undefined) {
      const cur = await tx.query<{ on: boolean; changed_at: Date | string }>(
        'SELECT "on", changed_at FROM safety_switches WHERE name = $1 FOR UPDATE',
        [i.name],
      );
      const row = cur.rows[0];
      if (row === undefined) return 'switch_changed';
      if (i.resume_guard.refuse_if_on && row.on === true) return 'already_on';
      if (new Date(row.changed_at).toISOString() !== i.resume_guard.seen_changed_at)
        return 'switch_changed';
    }
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
    if (i.also_audit !== undefined)
      await audit.record(tx, {
        actor: i.by,
        action: i.also_audit.action,
        target: i.also_audit.target,
        reason,
        detail: i.also_audit.detail,
      });
    return null;
  });
  return refused === null ? ok(undefined) : err(refused);
}
