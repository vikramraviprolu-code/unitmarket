import type { Database } from '@umsbx/contracts';

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

// provider_calls has no approval column, and only one approval ref is active per process, so the
// day's budget counts every sandbox call since UTC midnight (conservative; ASM-02-2).
export async function callsToday(db: Database, now: Date): Promise<number> {
  const r = await db.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM provider_calls WHERE transport_kind = 'sandbox' AND created_at >= $1`,
    [utcMidnight(now)],
  );
  return Number(r.rows[0]?.n ?? 0);
}
