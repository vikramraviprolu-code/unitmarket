import type { Database, SwitchName, SwitchReader } from '@umsbx/contracts';
import { MATCHES_REF, reservedToday } from './budget';

/**
 * RLR-3: every AI call site asks this before it runs the model. A missing row or a failed read
 * counts as off (the switch reader fails closed), so an unreachable database switches AI off.
 */
export function aiEnabled(switches: SwitchReader): Promise<boolean> {
  return switches.isOn('ai_enabled');
}

export interface SafetyStatus {
  switches: {
    name: SwitchName;
    on: boolean;
    changed_by: string;
    changed_at: string;
    reason: string;
  }[];
  budget: {
    approval_ref: string;
    operations: string[];
    max_amount_minor: number;
    max_calls_per_day: number;
    reserved_today: number;
    remaining_today: number;
    valid_until: string;
  } | null;
}

/** What `pnpm safety:status` prints: switch states and the budget left. No secrets are read. */
export async function readSafetyStatus(
  db: Database,
  now: Date,
  approval_ref: string | null,
): Promise<SafetyStatus> {
  const sw = await db.query<{
    name: SwitchName;
    on: boolean;
    changed_by: string;
    changed_at: Date | string;
    reason: string;
  }>('SELECT name, "on", changed_by, changed_at, reason FROM safety_switches ORDER BY name');
  const switches = sw.rows.map((r) => ({
    name: r.name,
    on: r.on === true,
    changed_by: r.changed_by,
    changed_at: new Date(r.changed_at).toISOString(),
    reason: r.reason,
  }));
  let budget: SafetyStatus['budget'] = null;
  if (approval_ref !== null && approval_ref !== '') {
    const a = await db.query<{
      approval_ref: string;
      operations: string[];
      max_amount_minor: number | string;
      max_calls_per_day: number;
      valid_until: Date | string;
    }>(
      `SELECT approval_ref, operations, max_amount_minor, max_calls_per_day, valid_until
         FROM outbound_approvals WHERE ${MATCHES_REF} AND valid_until > $2
        ORDER BY valid_until DESC, approval_ref DESC LIMIT 1`,
      [approval_ref, now.toISOString()],
    );
    const row = a.rows[0];
    if (row !== undefined) {
      // OPS-SW: the row found may be a console sitting under the configured reference.
      const used = await reservedToday(db, row.approval_ref, now);
      budget = {
        approval_ref: row.approval_ref,
        operations: row.operations,
        max_amount_minor: Number(row.max_amount_minor),
        max_calls_per_day: row.max_calls_per_day,
        reserved_today: used,
        remaining_today: Math.max(0, row.max_calls_per_day - used),
        valid_until: new Date(row.valid_until).toISOString(),
      };
    }
  }
  return { switches, budget };
}
