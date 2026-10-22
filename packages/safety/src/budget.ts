import type { Database, SqlExecutor } from '@umsbx/contracts';

export interface ApprovalRow {
  approval_ref: string;
  operations: string[];
  max_amount_minor: number;
  max_calls_per_day: number;
}

/** Midnight UTC of the day containing `now`, as ISO text. */
export function utcMidnight(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

// The active approval row for a ref: valid_until strictly after now.
export async function findActiveApproval(
  db: Database,
  ref: string,
  now: Date,
): Promise<ApprovalRow | null> {
  const r = await db.query<{
    approval_ref: string;
    operations: string[];
    max_amount_minor: number | string;
    max_calls_per_day: number;
  }>(
    `SELECT approval_ref, operations, max_amount_minor, max_calls_per_day
       FROM outbound_approvals WHERE approval_ref = $1 AND valid_until > $2`,
    [ref, now.toISOString()],
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  return {
    approval_ref: row.approval_ref,
    operations: row.operations,
    max_amount_minor: Number(row.max_amount_minor),
    max_calls_per_day: row.max_calls_per_day,
  };
}

// Review 4 H3. The daily call budget is a per-approval counter kept in audit_log rows with action
// 'gate.reserve' (target = approval_ref). The gate writes one row for every call it allows, inside
// one transaction that holds a row lock on the approval, so N concurrent checks at max-1 let
// exactly one through. Rows are append-only and survive restarts. provider_calls has no approval
// column, so it cannot carry a per-approval count (replaces ASM-02-2).
export const RESERVE_ACTION = 'gate.reserve';

export async function reservedToday(db: SqlExecutor, ref: string, now: Date): Promise<number> {
  const r = await db.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM audit_log WHERE action = $1 AND target = $2 AND created_at >= $3`,
    [RESERVE_ACTION, ref, utcMidnight(now)],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export type Reservation = 'reserved' | 'budget' | 'no_approval';

// Reserves one call against the approval, or says why not. The check and the insert are one
// transaction under `SELECT ... FOR UPDATE` on the approval row.
export async function reserveCall(
  db: Database,
  i: { approval_ref: string; operation: string; amount_minor: number | null },
  now: Date,
): Promise<Reservation> {
  return db.transaction(async (tx) => {
    const r = await tx.query<{ max_calls_per_day: number; valid_until: Date | string }>(
      `SELECT max_calls_per_day, valid_until FROM outbound_approvals
        WHERE approval_ref = $1 AND valid_until > $2 FOR UPDATE`,
      [i.approval_ref, now.toISOString()],
    );
    const row = r.rows[0];
    if (row === undefined) return 'no_approval';
    const used = await reservedToday(tx, i.approval_ref, now);
    if (used >= row.max_calls_per_day) return 'budget';
    const at = now.toISOString();
    await tx.query(
      `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
       VALUES ($1, 'system', NULL, $2, $3, $4, $5, $6, $6)`,
      [
        `gres_${at.slice(0, 10)}_${used + 1}_${i.approval_ref}`.slice(0, 200),
        RESERVE_ACTION,
        i.approval_ref,
        `reserved ${i.operation}`,
        JSON.stringify({
          approval_ref: i.approval_ref,
          operation: i.operation,
          amount_minor: i.amount_minor,
          n: used + 1,
        }),
        at,
      ],
    );
    return 'reserved';
  });
}
