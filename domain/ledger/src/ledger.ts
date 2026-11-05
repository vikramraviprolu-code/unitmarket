// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/core/ledger/ledger.ts. Adapted; owned by SBX.
// Append-only money ledger. There is no update and no delete function; a correction is a new
// entry. Rows are keyed (capture_id, kind, refund_id) so several partial refunds book (ASM-LED-1);
// a replay returns the existing entry id. Rules that the database also enforces (kind and
// refund_id pairing, one sale per capture, capture belongs to unit, currency equals the order
// currency, refunds within the sale) are checked here too, so a violation is a thrown programmer
// error from this module before any row is written (the caller raises the alert).
import { LedgerEntryInputSchema, LedgerEntrySchema, err, ok } from '@umsbx/contracts';
import type {
  CoreDeps,
  Id,
  LedgerEntry,
  LedgerEntryInput,
  Result,
  SqlExecutor,
} from '@umsbx/contracts';

export class LedgerRuleError extends Error {
  constructor(message: string) {
    super(`ledger: ${message}`);
    this.name = 'LedgerRuleError';
  }
}

type LedgerDeps = Pick<CoreDeps, 'clock' | 'ids' | 'environment'>;

interface Row {
  id: string;
  unit_id: string;
  capture_id: string;
  kind: string;
  amount_minor: number;
  currency: string;
  refund_id: string | null;
  ref_entry_id: string | null;
  created_at: string;
  environment: string;
}

const COLUMNS = `l.id, l.unit_id, l.capture_id, l.kind, l.amount_minor, l.currency, l.refund_id,
  l.ref_entry_id, l.environment,
  to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;

function toEntry(r: Row): LedgerEntry {
  return LedgerEntrySchema.parse({
    id: r.id,
    unit_id: r.unit_id,
    capture_id: r.capture_id,
    kind: r.kind,
    amount: { currency: r.currency, minor: Number(r.amount_minor) },
    refund_id: r.refund_id,
    ref_entry_id: r.ref_entry_id,
    created_at: r.created_at,
    environment: r.environment,
  });
}

// The kinds that belong to one refund carry its id (one row per refund id): refund, commission_reversal and, since POB-M1,
// the two reversals of the fee split and the payout adjustment. Every other kind carries none.
const CARRIES_REFUND_ID = new Set<string>([
  'refund',
  'commission_reversal',
  'fee_reversal',
  'payable_reversal',
  'payout_adjustment',
]);
// POB-M1: the new kinds are money facts; a row of 0 is never written.
const NEVER_ZERO = new Set<string>([
  'fee',
  'payable',
  'fee_reversal',
  'payable_reversal',
  'payout_adjustment',
]);

export async function appendLedgerEntry(
  tx: SqlExecutor,
  d: LedgerDeps,
  e: LedgerEntryInput,
): Promise<Result<LedgerEntry, { code: 'duplicate'; existing_entry_id: Id }>> {
  const input = LedgerEntryInputSchema.parse(e);

  if (input.kind === 'platform_fee') {
    throw new LedgerRuleError('platform_fee is never written in MVP-A (D-3)');
  }
  if (CARRIES_REFUND_ID.has(input.kind) && input.refund_id === null) {
    throw new LedgerRuleError(`refund_id is required for kind ${input.kind}`);
  }
  if (!CARRIES_REFUND_ID.has(input.kind) && input.refund_id !== null) {
    throw new LedgerRuleError(`refund_id must be null for kind ${input.kind}`);
  }
  if (
    (input.kind === 'refund' || input.kind === 'reversal' || NEVER_ZERO.has(input.kind)) &&
    input.amount.minor === 0
  ) {
    throw new LedgerRuleError(`a ${input.kind} of zero is not a money fact`);
  }

  // Lock the unit row: two refunds on one capture are checked one after the other.
  const unit = (
    await tx.query<{ capture_id: string | null; currency: string; environment: string }>(
      `SELECT u.capture_id, o.currency, o.environment
         FROM order_units u JOIN orders o ON o.id = u.order_id
        WHERE u.id = $1 FOR UPDATE OF u`,
      [input.unit_id],
    )
  ).rows[0];
  if (unit === undefined) throw new LedgerRuleError(`unit ${input.unit_id} does not exist`);
  if (unit.capture_id === null || unit.capture_id !== input.capture_id) {
    throw new LedgerRuleError(
      `capture ${input.capture_id} does not belong to unit ${input.unit_id}`,
    );
  }
  if (unit.currency !== input.amount.currency) {
    throw new LedgerRuleError(
      `currency ${input.amount.currency} does not match order currency ${unit.currency}`,
    );
  }
  if (unit.environment !== d.environment) {
    throw new LedgerRuleError(
      `environment ${d.environment} does not match order environment ${unit.environment}`,
    );
  }
  if (input.ref_entry_id !== null) {
    const ref = await tx.query('SELECT 1 FROM ledger_entries WHERE id = $1 AND capture_id = $2', [
      input.ref_entry_id,
      input.capture_id,
    ]);
    if (ref.rows.length === 0) {
      throw new LedgerRuleError('ref_entry_id must name an entry of the same capture');
    }
  }

  // The stored row for this key. A replay must carry the same money: another amount or currency
  // under the same key is a conflict (a caller bug or a forged id), never a silent duplicate.
  const existing = async (): Promise<Id | null> => {
    const r = await tx.query<{ id: string; amount_minor: number; currency: string }>(
      `SELECT id, amount_minor, currency FROM ledger_entries
        WHERE capture_id = $1 AND kind = $2 AND refund_id IS NOT DISTINCT FROM $3::text`,
      [input.capture_id, input.kind, input.refund_id],
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    if (Number(row.amount_minor) !== input.amount.minor || row.currency !== input.amount.currency) {
      throw new LedgerRuleError(
        `conflicting_replay: ${input.kind} ${input.refund_id ?? ''} for capture ${input.capture_id} is booked as ${String(row.amount_minor)} ${row.currency}, not ${String(input.amount.minor)} ${input.amount.currency}`,
      );
    }
    return row.id;
  };
  const dup = await existing();
  if (dup !== null) return err({ code: 'duplicate', existing_entry_id: dup });

  if (input.kind === 'refund' || input.kind === 'reversal') {
    const sums = (
      await tx.query<{ sold: string; refunded: string; reversed: string }>(
        `SELECT coalesce(sum(amount_minor) FILTER (WHERE kind = 'sale'), 0) AS sold,
                coalesce(sum(amount_minor) FILTER (WHERE kind = 'refund'), 0) AS refunded,
                coalesce(sum(amount_minor) FILTER (WHERE kind = 'reversal'), 0) AS reversed
           FROM ledger_entries WHERE capture_id = $1`,
        [input.capture_id],
      )
    ).rows[0]!;
    const remaining = Number(sums.sold) - Number(sums.refunded) - Number(sums.reversed);
    if (input.amount.minor > remaining) {
      throw new LedgerRuleError(
        `${input.kind} of ${String(input.amount.minor)} would exceed the remaining ${String(remaining)} of the sale for capture ${input.capture_id}`,
      );
    }
  }

  if (input.kind === 'fee_reversal' || input.kind === 'payable_reversal') {
    const base = input.kind === 'fee_reversal' ? 'fee' : 'payable';
    const sums = (
      await tx.query<{ base: string; done: string }>(
        `SELECT coalesce(sum(amount_minor) FILTER (WHERE kind = $2), 0) AS base,
                coalesce(sum(amount_minor) FILTER (WHERE kind = $3), 0) AS done
           FROM ledger_entries WHERE capture_id = $1`,
        [input.capture_id, base, input.kind],
      )
    ).rows[0]!;
    if (Number(sums.done) + input.amount.minor > Number(sums.base)) {
      throw new LedgerRuleError(
        `${input.kind} of ${String(input.amount.minor)} would exceed the ${base} of ${sums.base} (already reversed ${sums.done}) for capture ${input.capture_id}`,
      );
    }
  }

  const id = d.ids.next('led');
  const now = d.clock.now().toISOString();
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO ledger_entries (id, unit_id, capture_id, kind, amount_minor, currency, refund_id,
        ref_entry_id, environment, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      id,
      input.unit_id,
      input.capture_id,
      input.kind,
      input.amount.minor,
      input.amount.currency,
      input.refund_id,
      input.ref_entry_id,
      d.environment,
      now,
    ],
  );
  if (inserted.rows.length === 0) {
    const winner = await existing();
    if (winner === null) throw new LedgerRuleError('insert conflicted but no existing entry found');
    return err({ code: 'duplicate', existing_entry_id: winner });
  }
  return ok(
    LedgerEntrySchema.parse({
      ...input,
      id,
      created_at: now,
      environment: d.environment,
    }),
  );
}

const KIND_RANK = `CASE l.kind WHEN 'sale' THEN 0 WHEN 'paypal_fee' THEN 1 WHEN 'platform_fee' THEN 2
  WHEN 'refund' THEN 3 WHEN 'reversal' THEN 4 WHEN 'commission_reversal' THEN 5 WHEN 'fee' THEN 6
  WHEN 'payable' THEN 7 WHEN 'fee_reversal' THEN 8 WHEN 'payable_reversal' THEN 9 ELSE 10 END`;

// Rows in booking order: created_at, then kind (sale first), then refund id, then id.
export async function listLedger(
  db: SqlExecutor,
  f: { order_id?: Id; unit_id?: Id; capture_id?: string },
): Promise<LedgerEntry[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.order_id !== undefined) {
    params.push(f.order_id);
    where.push(`u.order_id = $${String(params.length)}`);
  }
  if (f.unit_id !== undefined) {
    params.push(f.unit_id);
    where.push(`l.unit_id = $${String(params.length)}`);
  }
  if (f.capture_id !== undefined) {
    params.push(f.capture_id);
    where.push(`l.capture_id = $${String(params.length)}`);
  }
  const r = await db.query<Row>(
    `SELECT ${COLUMNS} FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.created_at, ${KIND_RANK}, l.refund_id NULLS FIRST, l.id`,
    params,
  );
  return r.rows.map(toEntry);
}
