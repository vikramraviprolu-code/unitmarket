// Payee requests and the operator's decision (PUB-A2, decisions D-041, D-062, D-065 items 28 to 31).
//
// A publisher can ask to be paid into another merchant id. The request does nothing by itself: an
// operator with the second factor verifies it by typing the requested id again, and only then does the
// publisher row change. A publisher session can never verify, not even its own request, and never writes
// the publisher row. On the hosted sandbox app (environment 'sandbox') verification is refused here:
// putting a named payee into a PayPal order is an owner command under D-062 (overnight assumption 3).
//
// The whole merchant id is held in payee_change_requests and publishers and nowhere else. Audit rows
// and every returned view carry the last 4 characters only. Ids use existing prefixes: 'prp' for a
// request and 'aud' for a decision (the prefix list is a contract this lane does not change).
import { err, ok } from '@umsbx/contracts';
import type { Actor, CoreDeps, Database, Id, Result, SqlExecutor } from '@umsbx/contracts';

/** A merchant id is 13 capital letters and digits. */
export const MERCHANT_ID_PATTERN = /^[A-Z0-9]{13}$/;

export type PayeeDeps = Pick<CoreDeps, 'db' | 'clock' | 'ids' | 'audit' | 'environment'>;

export type PayeeErrorCode =
  | 'not_publisher'
  | 'not_operator'
  | 'mfa_required'
  | 'invalid_merchant_id'
  | 'invalid_input'
  | 'same_as_current'
  | 'not_found'
  | 'already_decided'
  | 'id_mismatch'
  | 'owner_command_required'
  | 'merchant_in_use';
export interface PayeeError {
  code: PayeeErrorCode;
}

export type RequestState = 'open' | 'verified' | 'rejected';
export interface PayeeHistoryRow {
  request_id: Id;
  state: RequestState;
  requested_last4: string;
  created_at: string;
  decided_at: string | null;
}
export interface PayeeView {
  last4: string | null;
  verified_at: string | null;
  /** Newest first. */
  history: PayeeHistoryRow[];
}
export interface OpenRequest {
  request_id: Id;
  publisher_id: Id;
  publisher_name: string;
  requested_last4: string;
  created_at: string;
}

const last4Of = (id: string | null): string | null => (id === null ? null : id.slice(-4));
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const fail = (code: PayeeErrorCode): Result<never, PayeeError> => err({ code });

/** Thrown inside a transaction to roll it back; the caller turns it into an error value. */
class Refused extends Error {
  // Declared field, not a parameter property: the offline scripts run this file in Node's strip-only TypeScript mode.
  readonly code: PayeeErrorCode;
  constructor(code: PayeeErrorCode) {
    super(code);
    this.code = code;
  }
}
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';

/**
 * What a publisher sees on "Where you get paid": the stored payee (last 4 only), when it was verified
 * and its own requests newest first. Every query filters by the actor's publisher id. Null for any
 * actor that is not a publisher, and for a publisher id that names no row.
 */
export async function payeeView(db: Database, actor: Actor): Promise<PayeeView | null> {
  if (actor.kind !== 'publisher') return null;
  const p = await db.query<{ paypal_merchant_id: string | null; payee_verified_at: unknown }>(
    'SELECT paypal_merchant_id, payee_verified_at FROM publishers WHERE id = $1',
    [actor.publisher_id],
  );
  const row = p.rows[0];
  if (row === undefined) return null;
  const h = await db.query<{
    id: string;
    requested_merchant_id: string;
    created_at: unknown;
    decision: 'verified' | 'rejected' | null;
    decided_at: unknown;
  }>(
    `SELECT r.id, r.requested_merchant_id, r.created_at, d.decision, d.created_at AS decided_at
       FROM payee_change_requests r
       LEFT JOIN payee_decisions d ON d.request_id = r.id
      WHERE r.publisher_id = $1
      ORDER BY r.created_at DESC, r.id DESC`,
    [actor.publisher_id],
  );
  return {
    last4: last4Of(row.paypal_merchant_id),
    verified_at: isoOrNull(row.payee_verified_at),
    history: h.rows.map((r) => ({
      request_id: r.id,
      state: r.decision ?? 'open',
      requested_last4: r.requested_merchant_id.slice(-4),
      created_at: iso(r.created_at),
      decided_at: isoOrNull(r.decided_at),
    })),
  };
}

/**
 * A publisher asks to be paid into another merchant id. Stores one request and one audit row; the
 * publisher row is not touched. The note is 1 to 200 characters and is kept with the request only.
 */
export async function requestPayeeChange(
  deps: PayeeDeps,
  actor: Actor,
  input: { merchant_id: string; note: string },
): Promise<Result<{ request_id: Id }, PayeeError>> {
  if (actor.kind !== 'publisher') return fail('not_publisher');
  if (!MERCHANT_ID_PATTERN.test(input.merchant_id)) return fail('invalid_merchant_id');
  const note = input.note.trim();
  if (note.length < 1 || note.length > 200) return fail('invalid_input');
  const publisher_id = actor.publisher_id;
  try {
    return await deps.db.transaction(async (tx) => {
      const p = await tx.query<{ paypal_merchant_id: string | null }>(
        'SELECT paypal_merchant_id FROM publishers WHERE id = $1',
        [publisher_id],
      );
      const row = p.rows[0];
      if (row === undefined) throw new Refused('not_publisher');
      if (row.paypal_merchant_id === input.merchant_id) throw new Refused('same_as_current');
      const at = deps.clock.now().toISOString();
      const request_id = deps.ids.next('prp');
      await tx.query(
        `INSERT INTO payee_change_requests (id, publisher_id, requested_merchant_id, note, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [request_id, publisher_id, input.merchant_id, note, publisher_id, at],
      );
      await deps.audit.record(tx, {
        actor,
        action: 'payee.change_requested',
        target: request_id,
        reason: null,
        detail: {
          requested_last4: input.merchant_id.slice(-4),
          current_last4: last4Of(row.paypal_merchant_id),
        },
      });
      return ok({ request_id });
    });
  } catch (e) {
    if (e instanceof Refused) return fail(e.code);
    throw e;
  }
}

/**
 * The operator's queue: requests with no decision, oldest first, with the last 4 of the requested id
 * only. The operator confirms the whole id with the publisher out of band and types it again to decide.
 */
export async function listOpenRequests(
  db: Database,
  actor: Actor,
): Promise<Result<OpenRequest[], PayeeError>> {
  // INT-OPS-A / OPS-A.7: a read, so an operator without the code may open the queue (last 4 only). The decision still needs it.
  if (actor.kind !== 'operator') return fail('not_operator');
  const r = await db.query<{
    id: string;
    publisher_id: string;
    display_name: string;
    requested_merchant_id: string;
    created_at: unknown;
  }>(
    `SELECT r.id, r.publisher_id, p.display_name, r.requested_merchant_id, r.created_at
       FROM payee_change_requests r
       JOIN publishers p ON p.id = r.publisher_id
      WHERE NOT EXISTS (SELECT 1 FROM payee_decisions d WHERE d.request_id = r.id)
      ORDER BY r.created_at ASC, r.id ASC`,
  );
  return ok(
    r.rows.map((x) => ({
      request_id: x.id,
      publisher_id: x.publisher_id,
      publisher_name: x.display_name,
      requested_last4: x.requested_merchant_id.slice(-4),
      created_at: iso(x.created_at),
    })),
  );
}

/** One audit row for a refused decision, written on its own so it survives a rolled back attempt. */
async function auditRefusal(
  deps: PayeeDeps,
  operator: Actor,
  request_id: Id,
  why: PayeeErrorCode,
): Promise<void> {
  await deps.db.transaction((tx: SqlExecutor) =>
    deps.audit.record(tx, {
      actor: operator,
      action: 'payee.verify_refused',
      target: request_id,
      reason: why,
      detail: { environment: deps.environment },
    }),
  );
}

/**
 * An operator with the second factor decides one request. Verify needs the full id typed again and
 * equal to the stored request; it sets the publisher's merchant id, the verification time and
 * payee_shared = false in the same transaction as the decision row and one audit row (last 4 only).
 * Reject writes the decision row and changes nothing else. In sandbox mode verify is refused with
 * owner_command_required and changes nothing (D-062).
 */
export async function decidePayeeRequest(
  deps: PayeeDeps,
  operator: Actor,
  input: {
    request_id: string;
    merchant_id_retyped: string;
    decision: 'verified' | 'rejected';
    reason: string;
  },
): Promise<Result<{ decision: 'verified' | 'rejected' }, PayeeError>> {
  if (operator.kind !== 'operator') return fail('not_operator');
  if (!operator.mfa) return fail('mfa_required');
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 200) return fail('invalid_input');

  const found = await deps.db.query<{
    id: string;
    publisher_id: string;
    requested_merchant_id: string;
  }>('SELECT id, publisher_id, requested_merchant_id FROM payee_change_requests WHERE id = $1', [
    input.request_id,
  ]);
  const req = found.rows[0];
  if (req === undefined) return fail('not_found');

  if (input.decision === 'verified') {
    if (deps.environment !== 'dryrun') {
      await auditRefusal(deps, operator, req.id, 'owner_command_required');
      return fail('owner_command_required');
    }
    // Exact comparison, no trimming and no case folding: the operator types the id again.
    if (input.merchant_id_retyped !== req.requested_merchant_id) {
      await auditRefusal(deps, operator, req.id, 'id_mismatch');
      return fail('id_mismatch');
    }
  }

  try {
    return await deps.db.transaction(async (tx) => {
      // The publisher row is locked first, so two decisions on requests of one publisher take turns.
      const p = await tx.query<{ paypal_merchant_id: string | null }>(
        'SELECT paypal_merchant_id FROM publishers WHERE id = $1 FOR UPDATE',
        [req.publisher_id],
      );
      const pub = p.rows[0];
      if (pub === undefined) throw new Refused('not_found');
      const done = await tx.query('SELECT 1 FROM payee_decisions WHERE request_id = $1', [req.id]);
      if (done.rows.length > 0) throw new Refused('already_decided');
      const at = deps.clock.now().toISOString();
      try {
        await tx.query(
          `INSERT INTO payee_decisions (id, request_id, decision, operator_id, reason, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [deps.ids.next('aud'), req.id, input.decision, operator.operator_id, reason, at],
        );
      } catch (e) {
        if (isUniqueViolation(e)) throw new Refused('already_decided');
        throw e;
      }
      if (input.decision === 'verified') {
        try {
          await tx.query(
            `UPDATE publishers
                SET paypal_merchant_id = $2, payee_verified_at = $3, payee_shared = false, updated_at = $3
              WHERE id = $1`,
            [req.publisher_id, req.requested_merchant_id, at],
          );
        } catch (e) {
          if (isUniqueViolation(e)) throw new Refused('merchant_in_use');
          throw e;
        }
      }
      await deps.audit.record(tx, {
        actor: operator,
        action: input.decision === 'verified' ? 'payee.verified' : 'payee.rejected',
        target: req.id,
        reason,
        detail:
          input.decision === 'verified'
            ? {
                publisher_id: req.publisher_id,
                old_last4: last4Of(pub.paypal_merchant_id),
                new_last4: req.requested_merchant_id.slice(-4),
              }
            : {
                publisher_id: req.publisher_id,
                requested_last4: req.requested_merchant_id.slice(-4),
              },
      });
      return ok({ decision: input.decision });
    });
  } catch (e) {
    if (e instanceof Refused) {
      await auditRefusal(deps, operator, req.id, e.code);
      return fail(e.code);
    }
    throw e;
  }
}
