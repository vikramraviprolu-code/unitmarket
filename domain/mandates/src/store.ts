// API-B (G1, G9): create, read and revoke a mandate, and the budget an agent sees. A mandate belongs to one
// buyer and one of that buyer's agent keys; every read and write names the buyer, and a mandate of someone
// else is "not found", never "forbidden". Expired open mandates are closed when a new one is made.
import { err, ok } from '@umsbx/contracts';
import type { Actor, Database, Result } from '@umsbx/contracts';
import { ASK_BUYER_TEXT, remainingOf } from './budget';
import type { MandateRow } from './budget';
import { MANDATE_COLUMNS, iso, settleHeld, toRow } from './reserve';
import type { MandateDeps, RawMandate } from './reserve';

/** The longest a mandate may run: a cap is a short grant, renewed on purpose. */
export const MAX_MANDATE_DAYS = 90;

export interface MandateView extends MandateRow {
  remaining_total_minor: number | null;
  remaining_count: number | null;
  created_at: string;
}

export interface CreateMandateInput {
  buyer_id: string;
  agent_key_id: string;
  currency: string;
  max_total_minor?: number | null;
  max_count?: number | null;
  max_per_purchase_minor?: number | null;
  expires_at: string;
}

export type CreateError =
  'invalid_caps' | 'invalid_currency' | 'invalid_expiry' | 'unknown_agent_key' | 'mandate_active';

export type BudgetResult =
  | {
      status: 'active';
      mandate_id: string;
      currency: string;
      remaining_total_minor: number | null;
      remaining_count: number | null;
      max_per_purchase_minor: number | null;
      expires_at: string;
    }
  | { status: 'mandate_required'; reason: 'none' | 'revoked' | 'expired'; ask_buyer: string };

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';
const buyerActor = (buyer_id: string): Actor => ({ kind: 'buyer', buyer_id });
const validCap = (v: number | null | undefined): boolean =>
  v === null || v === undefined || (Number.isInteger(v) && v >= 1 && v < 2 ** 31);

function toView(r: RawMandate): MandateView {
  const row = toRow(r);
  return { ...row, ...remainingOf(row), created_at: iso(r.created_at) };
}

export async function createMandate(
  db: Database,
  deps: MandateDeps,
  input: CreateMandateInput,
): Promise<Result<MandateView, CreateError>> {
  const total = input.max_total_minor ?? null;
  const count = input.max_count ?? null;
  const per = input.max_per_purchase_minor ?? null;
  if (total === null && count === null) return err('invalid_caps');
  if (![total, count, per].every(validCap)) return err('invalid_caps');
  if (!/^[A-Z]{3}$/.test(input.currency)) return err('invalid_currency');
  const now = deps.clock.now();
  const end = new Date(input.expires_at).getTime();
  if (
    !Number.isFinite(end) ||
    end <= now.getTime() ||
    end > now.getTime() + MAX_MANDATE_DAYS * 86_400_000
  ) {
    return err('invalid_expiry');
  }
  const at = now.toISOString();
  const id = deps.ids.next('man');
  try {
    return await db.transaction(async (tx): Promise<Result<MandateView, CreateError>> => {
      const key = await tx.query(
        `SELECT 1 FROM api_keys
          WHERE id = $1 AND key_kind = 'agent' AND owner_kind = 'buyer' AND owner_id = $2 AND revoked_at IS NULL`,
        [input.agent_key_id, input.buyer_id],
      );
      if (key.rows.length === 0) return err('unknown_agent_key');
      // An open mandate whose time has passed is closed here, so it does not block a new one.
      await tx.query(
        'UPDATE mandates SET revoked_at = $2, updated_at = $2 WHERE agent_key_id = $1 AND revoked_at IS NULL AND expires_at <= $2',
        [input.agent_key_id, at],
      );
      const open = await tx.query(
        'SELECT 1 FROM mandates WHERE agent_key_id = $1 AND revoked_at IS NULL',
        [input.agent_key_id],
      );
      if (open.rows.length > 0) return err('mandate_active');
      await tx.query(
        `INSERT INTO mandates (id, buyer_id, agent_key_id, currency, max_total_minor, max_count, max_per_purchase_minor,
                               expires_at, revoked_at, spent_minor, used_count, exhausted_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, 0, 0, NULL, $9, $9)`,
        [
          id,
          input.buyer_id,
          input.agent_key_id,
          input.currency,
          total,
          count,
          per,
          new Date(end).toISOString(),
          at,
        ],
      );
      await deps.audit.record(tx, {
        actor: buyerActor(input.buyer_id),
        action: 'mandate.created',
        target: id,
        reason: null,
        detail: {
          agent_key_id: input.agent_key_id,
          currency: input.currency,
          max_total_minor: total ?? 0,
          max_count: count ?? 0,
          max_per_purchase_minor: per ?? 0,
        },
      });
      const made = await tx.query<RawMandate>(
        `SELECT ${MANDATE_COLUMNS} FROM mandates WHERE id = $1`,
        [id],
      );
      return ok(toView(made.rows[0]!));
    });
  } catch (e) {
    // Two creates for one key at once: the unique index lets one in.
    if (isUniqueViolation(e)) return err('mandate_active');
    throw e;
  }
}

/** The buyer's own mandate, or null. */
export async function getMandate(
  db: Pick<Database, 'query'>,
  buyer_id: string,
  id: string,
): Promise<MandateView | null> {
  const r = await db.query<RawMandate>(
    `SELECT ${MANDATE_COLUMNS} FROM mandates WHERE id = $1 AND buyer_id = $2`,
    [id, buyer_id],
  );
  return r.rows[0] === undefined ? null : toView(r.rows[0]);
}

/** Ends a mandate for good. Revoking again keeps the first time and writes no second audit row. */
export async function revokeMandate(
  db: Database,
  deps: MandateDeps,
  input: { buyer_id: string; id: string },
): Promise<Result<MandateView, 'not_found'>> {
  return db.transaction(async (tx): Promise<Result<MandateView, 'not_found'>> => {
    const found = await tx.query<RawMandate>(
      `SELECT ${MANDATE_COLUMNS} FROM mandates WHERE id = $1 AND buyer_id = $2 FOR UPDATE`,
      [input.id, input.buyer_id],
    );
    const row = found.rows[0];
    if (row === undefined) return err('not_found');
    if (row.revoked_at !== null) return ok(toView(row));
    const at = deps.clock.now().toISOString();
    await tx.query('UPDATE mandates SET revoked_at = $2, updated_at = $2 WHERE id = $1', [
      row.id,
      at,
    ]);
    await deps.audit.record(tx, {
      actor: buyerActor(input.buyer_id),
      action: 'mandate.revoked',
      target: row.id,
      reason: null,
      detail: { agent_key_id: row.agent_key_id },
    });
    return ok(toView({ ...row, revoked_at: at }));
  });
}

/** INT-OPS-C (C3, C4): why an operator revoked a cap. A closed list, never free text; it lands in the audit action. */
export const OPERATOR_REVOKE_REASONS = ['abuse', 'owner_request', 'compromised', 'other'] as const;
export type OperatorRevokeReason = (typeof OPERATOR_REVOKE_REASONS)[number];
const REASON_SET: ReadonlySet<string> = new Set(OPERATOR_REVOKE_REASONS);

export type OperatorRevokeError = 'not_found' | 'not_operator' | 'mfa_required' | 'invalid_reason';

/**
 * INT-OPS-C: an operator ends any buyer's mandate. The same locked, idempotent revoke as revokeMandate, without
 * the buyer filter. Only an operator whose session showed the second factor (strictly `mfa === true`, like
 * refunds) may do it. The reason code is written in clear in the audit action (`mandate.revoked.<code>`);
 * audit_log.reason stays empty. A mandate revoked already is answered as it is, with no second audit row.
 */
export async function revokeMandateAsOperator(
  db: Database,
  deps: MandateDeps,
  operator: Actor,
  input: { id: string; reason_code: OperatorRevokeReason },
): Promise<Result<MandateView, OperatorRevokeError>> {
  if (operator.kind !== 'operator') return err('not_operator');
  if (operator.mfa !== true) return err('mfa_required');
  if (!REASON_SET.has(input.reason_code)) return err('invalid_reason');
  return db.transaction(async (tx): Promise<Result<MandateView, OperatorRevokeError>> => {
    const found = await tx.query<RawMandate>(
      `SELECT ${MANDATE_COLUMNS} FROM mandates WHERE id = $1 FOR UPDATE`,
      [input.id],
    );
    const row = found.rows[0];
    if (row === undefined) return err('not_found');
    if (row.revoked_at !== null) return ok(toView(row));
    const at = deps.clock.now().toISOString();
    await tx.query('UPDATE mandates SET revoked_at = $2, updated_at = $2 WHERE id = $1', [
      row.id,
      at,
    ]);
    await deps.audit.record(tx, {
      actor: operator,
      action: `mandate.revoked.${input.reason_code}`,
      target: row.id,
      reason: null,
      detail: { agent_key_id: row.agent_key_id, buyer_id: row.buyer_id },
    });
    return ok(toView({ ...row, revoked_at: at }));
  });
}

/**
 * What an agent key has left. A paid or ended order settles first, so room given back by an abandoned order
 * shows. With no mandate (or a revoked or expired one) the answer is the words to ask the buyer with.
 */
export async function checkBudget(
  db: Database,
  deps: MandateDeps,
  input: { buyer_id: string; agent_key_id: string },
): Promise<BudgetResult> {
  return db.transaction(async (tx): Promise<BudgetResult> => {
    const latest = await tx.query<RawMandate>(
      `SELECT ${MANDATE_COLUMNS} FROM mandates WHERE buyer_id = $1 AND agent_key_id = $2
        ORDER BY (revoked_at IS NULL) DESC, created_at DESC, id DESC LIMIT 1`,
      [input.buyer_id, input.agent_key_id],
    );
    const first = latest.rows[0];
    if (first === undefined)
      return { status: 'mandate_required', reason: 'none', ask_buyer: ASK_BUYER_TEXT };
    if (first.revoked_at !== null)
      return { status: 'mandate_required', reason: 'revoked', ask_buyer: ASK_BUYER_TEXT };
    if (deps.clock.now().getTime() >= new Date(iso(first.expires_at)).getTime()) {
      return { status: 'mandate_required', reason: 'expired', ask_buyer: ASK_BUYER_TEXT };
    }
    await tx.query('SELECT id FROM mandates WHERE id = $1 FOR UPDATE', [first.id]);
    await settleHeld(tx, deps, first.id);
    const fresh = await tx.query<RawMandate>(
      `SELECT ${MANDATE_COLUMNS} FROM mandates WHERE id = $1`,
      [first.id],
    );
    const row = toRow(fresh.rows[0]!);
    return {
      status: 'active',
      mandate_id: row.id,
      currency: row.currency,
      ...remainingOf(row),
      max_per_purchase_minor: row.max_per_purchase_minor,
      expires_at: row.expires_at,
    };
  });
}
