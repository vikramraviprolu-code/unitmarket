// API-B (G1, L item): booking against a mandate. reserve is ONE conditional UPDATE that checks every rule
// and adds the amount in the same statement, so two callers cannot both take the last room; the CHECKs on the
// table are a second guard. release gives the room back, commit keeps it. A commit that leaves no room writes
// mandate.exhausted in the same transaction, once. Every function that touches a reservation locks the
// mandate row first (mandate, then reservations), so concurrent settles cannot deadlock.
import { err, ok } from '@umsbx/contracts';
import type { AuditSink, Clock, EventOutbox, Id, Ids, Result, SqlExecutor } from '@umsbx/contracts';
import { evaluate, MAX_AMOUNT_MINOR } from './budget';
import type { MandateRow, RefusalReason } from './budget';

export interface MandateDeps {
  clock: Clock;
  ids: Ids;
  outbox: EventOutbox;
  audit: AuditSink;
}

export interface ReserveInput {
  mandate_id: string;
  buyer_id: string;
  agent_key_id: string;
  amount_minor: number;
  currency: string;
}

export type ReserveError = RefusalReason | 'mandate_not_found';

export const MANDATE_COLUMNS = `id, buyer_id, agent_key_id, currency, max_total_minor, max_count, max_per_purchase_minor,
       expires_at, revoked_at, spent_minor, used_count, exhausted_at, created_at`;

export interface RawMandate {
  id: string;
  buyer_id: string;
  agent_key_id: string;
  currency: string;
  max_total_minor: number | null;
  max_count: number | null;
  max_per_purchase_minor: number | null;
  expires_at: unknown;
  revoked_at: unknown;
  spent_minor: number;
  used_count: number;
  exhausted_at: unknown;
  created_at: unknown;
}

export const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
export const isoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : iso(v);

export function toRow(r: RawMandate): MandateRow {
  return {
    id: r.id,
    buyer_id: r.buyer_id,
    agent_key_id: r.agent_key_id,
    currency: r.currency,
    max_total_minor: r.max_total_minor === null ? null : Number(r.max_total_minor),
    max_count: r.max_count === null ? null : Number(r.max_count),
    max_per_purchase_minor:
      r.max_per_purchase_minor === null ? null : Number(r.max_per_purchase_minor),
    expires_at: iso(r.expires_at),
    revoked_at: isoOrNull(r.revoked_at),
    spent_minor: Number(r.spent_minor),
    used_count: Number(r.used_count),
  };
}

/** Locks the mandate row of a reservation (mandate first). Null when the reservation is unknown. */
async function lockOf(tx: SqlExecutor, reservation_id: string): Promise<string | null> {
  const r = await tx.query<{ mandate_id: string }>(
    'SELECT mandate_id FROM mandate_reservations WHERE id = $1',
    [reservation_id],
  );
  const mandate_id = r.rows[0]?.mandate_id;
  if (mandate_id === undefined) return null;
  await tx.query('SELECT id FROM mandates WHERE id = $1 FOR UPDATE', [mandate_id]);
  return mandate_id;
}

/**
 * Books one purchase: the amount and one use of the count, in one conditional UPDATE. The answer says why
 * when nothing was booked. A mandate of another buyer or another agent key is `mandate_not_found`, the same
 * as one that does not exist.
 */
export async function reserve(
  tx: SqlExecutor,
  deps: Pick<MandateDeps, 'clock' | 'ids' | 'outbox'>,
  input: ReserveInput,
): Promise<Result<{ reservation_id: Id }, ReserveError>> {
  const a = input.amount_minor;
  if (!Number.isInteger(a) || a < 1 || a > MAX_AMOUNT_MINOR) return err('invalid_amount');
  const now = deps.clock.now();
  const at = now.toISOString();
  // A paid or ended order of this mandate settles first, so its room is counted correctly.
  await tx.query('SELECT id FROM mandates WHERE id = $1 FOR UPDATE', [input.mandate_id]);
  await settleHeld(tx, deps, input.mandate_id);
  const booked = await tx.query<{ id: string }>(
    `UPDATE mandates
        SET spent_minor = spent_minor + $5::integer, used_count = used_count + 1, updated_at = $6
      WHERE id = $1 AND buyer_id = $2 AND agent_key_id = $3 AND currency = $4
        AND revoked_at IS NULL AND expires_at > $6
        AND (max_per_purchase_minor IS NULL OR $5::integer <= max_per_purchase_minor)
        AND (max_total_minor IS NULL OR spent_minor + $5::integer <= max_total_minor)
        AND (max_count IS NULL OR used_count + 1 <= max_count)
      RETURNING id`,
    [input.mandate_id, input.buyer_id, input.agent_key_id, input.currency, a, at],
  );
  if (booked.rows.length === 0) {
    const found = await tx.query<RawMandate>(
      `SELECT ${MANDATE_COLUMNS} FROM mandates WHERE id = $1 AND buyer_id = $2 AND agent_key_id = $3`,
      [input.mandate_id, input.buyer_id, input.agent_key_id],
    );
    const row = found.rows[0];
    if (row === undefined) return err('mandate_not_found');
    const verdict = evaluate(toRow(row), { amount_minor: a, currency: input.currency }, now);
    return err(verdict.ok ? 'cap_exhausted' : verdict.reason);
  }
  const id = deps.ids.next('rsv');
  await tx.query(
    `INSERT INTO mandate_reservations (id, mandate_id, order_id, amount_minor, state, created_at, settled_at)
     VALUES ($1, $2, NULL, $3, 'held', $4, NULL)`,
    [id, input.mandate_id, a, at],
  );
  return ok({ reservation_id: id });
}

/** Ties a held reservation to the order it was booked for (once). */
export async function attachOrder(
  tx: SqlExecutor,
  reservation_id: string,
  order_id: string,
): Promise<boolean> {
  const r = await tx.query(
    'UPDATE mandate_reservations SET order_id = $2 WHERE id = $1 AND order_id IS NULL RETURNING id',
    [reservation_id, order_id],
  );
  return r.rows.length === 1;
}

/** Gives the room back. True once; false when the reservation is unknown or already settled. */
export async function release(
  tx: SqlExecutor,
  deps: Pick<MandateDeps, 'clock'>,
  reservation_id: string,
): Promise<boolean> {
  const mandate_id = await lockOf(tx, reservation_id);
  if (mandate_id === null) return false;
  const at = deps.clock.now().toISOString();
  const done = await tx.query<{ amount_minor: number }>(
    `UPDATE mandate_reservations SET state = 'released', settled_at = $2
      WHERE id = $1 AND state = 'held' RETURNING amount_minor`,
    [reservation_id, at],
  );
  const row = done.rows[0];
  if (row === undefined) return false;
  await tx.query(
    `UPDATE mandates SET spent_minor = spent_minor - $2::integer, used_count = used_count - 1, updated_at = $3
      WHERE id = $1`,
    [mandate_id, Number(row.amount_minor), at],
  );
  return true;
}

/** Keeps the spend. True once; the commit that uses the last room writes mandate.exhausted. */
export async function commit(
  tx: SqlExecutor,
  deps: Pick<MandateDeps, 'clock' | 'ids' | 'outbox'>,
  reservation_id: string,
): Promise<boolean> {
  const mandate_id = await lockOf(tx, reservation_id);
  if (mandate_id === null) return false;
  const at = deps.clock.now().toISOString();
  const done = await tx.query(
    `UPDATE mandate_reservations SET state = 'committed', settled_at = $2
      WHERE id = $1 AND state = 'held' RETURNING id`,
    [reservation_id, at],
  );
  if (done.rows.length === 0) return false;
  await exhaustIfFull(tx, deps, mandate_id, at);
  return true;
}

/** Judged on committed totals only: a held reservation may still be released. Written once. */
async function exhaustIfFull(
  tx: SqlExecutor,
  deps: Pick<MandateDeps, 'outbox'>,
  mandate_id: string,
  at: string,
): Promise<void> {
  const r = await tx.query<
    RawMandate & { committed_minor: string | number; committed_count: string | number }
  >(
    `SELECT ${MANDATE_COLUMNS},
            (SELECT coalesce(sum(amount_minor), 0) FROM mandate_reservations x WHERE x.mandate_id = m.id AND x.state = 'committed') AS committed_minor,
            (SELECT count(*) FROM mandate_reservations x WHERE x.mandate_id = m.id AND x.state = 'committed') AS committed_count
       FROM mandates m WHERE m.id = $1`,
    [mandate_id],
  );
  const m = r.rows[0];
  if (m === undefined || m.exhausted_at !== null) return;
  const money = Number(m.committed_minor);
  const n = Number(m.committed_count);
  let reason: 'count' | 'money' | null = null;
  if (m.max_count !== null && n >= Number(m.max_count)) reason = 'count';
  else if (m.max_total_minor !== null && money >= Number(m.max_total_minor)) reason = 'money';
  if (reason === null) return;
  const stamped = await tx.query(
    'UPDATE mandates SET exhausted_at = $2, updated_at = $2 WHERE id = $1 AND exhausted_at IS NULL RETURNING id',
    [mandate_id, at],
  );
  if (stamped.rows.length === 0) return;
  await deps.outbox.append(tx, {
    type: 'mandate.exhausted',
    payload: {
      mandate_id,
      buyer_id: m.buyer_id,
      agent_key_id: m.agent_key_id,
      reason,
      exhausted_at: at,
    },
  });
}

/**
 * Settles the held reservations of a mandate whose order ended: paid orders commit, failed and abandoned
 * orders release. Orders still in flight stay held. Runs under the mandate row lock the caller took.
 */
export async function settleHeld(
  tx: SqlExecutor,
  deps: Pick<MandateDeps, 'clock' | 'ids' | 'outbox'>,
  mandate_id: string,
): Promise<number> {
  const r = await tx.query<{ id: string; status: string }>(
    `SELECT r.id, o.status
       FROM mandate_reservations r JOIN orders o ON o.id = r.order_id
      WHERE r.mandate_id = $1 AND r.state = 'held'
        AND o.status IN ('paid', 'paid_partial', 'failed', 'abandoned')
      ORDER BY r.created_at, r.id`,
    [mandate_id],
  );
  for (const row of r.rows) {
    if (row.status === 'paid' || row.status === 'paid_partial') await commit(tx, deps, row.id);
    else await release(tx, deps, row.id);
  }
  return r.rows.length;
}
