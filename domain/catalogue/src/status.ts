// Suspend and reactivate a publisher (PUB-D, decisions D-041, D-051; proposal 3I). Operator with the
// second factor only. A suspended publisher's offers leave the authorised list and answer no_match to a
// new quote (read.ts and offer-entry check the stored status), and its open quotes end now so none of
// them can still be approved. Orders, units, entitlements, refunds and the ledger are not touched.
// One audit row per change. Approving an applicant is not done here (a later lane).
import { err, ok } from '@umsbx/contracts';
import type { Actor, CoreDeps, Id, Result } from '@umsbx/contracts';

export type StatusDeps = Pick<CoreDeps, 'db' | 'clock' | 'ids' | 'audit'>;

export type StatusErrorCode =
  'not_operator' | 'mfa_required' | 'invalid_input' | 'not_found' | 'unchanged' | 'not_allowed';
export interface StatusError {
  code: StatusErrorCode;
}

const fail = (code: StatusErrorCode): Result<never, StatusError> => err({ code });

class Refused extends Error {
  constructor(readonly code: StatusErrorCode) {
    super(code);
  }
}

export async function setPublisherStatus(
  deps: StatusDeps,
  operator: Actor,
  input: { publisher_id: Id; status: 'suspended' | 'active'; reason: string },
): Promise<Result<{ status: 'suspended' | 'active' }, StatusError>> {
  if (operator.kind !== 'operator') return fail('not_operator');
  if (!operator.mfa) return fail('mfa_required');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (
    reason.length < 3 ||
    reason.length > 200 ||
    (input.status !== 'suspended' && input.status !== 'active') ||
    typeof input.publisher_id !== 'string' ||
    input.publisher_id.length === 0
  ) {
    return fail('invalid_input');
  }
  try {
    return await deps.db.transaction(async (tx) => {
      // The row is locked, so two changes to one publisher take turns.
      const p = await tx.query<{ status: string }>(
        'SELECT status FROM publishers WHERE id = $1 FOR UPDATE',
        [input.publisher_id],
      );
      const current = p.rows[0]?.status;
      if (current === undefined) throw new Refused('not_found');
      if (current === 'applied') throw new Refused('not_allowed');
      if (current === input.status) throw new Refused('unchanged');
      const at = deps.clock.now().toISOString();
      await tx.query('UPDATE publishers SET status = $2, updated_at = $3 WHERE id = $1', [
        input.publisher_id,
        input.status,
        at,
      ]);
      if (input.status === 'suspended') {
        // Only ever shortens a quote: it ends now, never later.
        await tx.query(
          `UPDATE quotes SET expires_at = $2, updated_at = $2
            WHERE expires_at > $2 AND offer_id IN (SELECT id FROM offers WHERE publisher_id = $1)`,
          [input.publisher_id, at],
        );
      }
      await deps.audit.record(tx, {
        actor: operator,
        action: input.status === 'suspended' ? 'publisher.suspended' : 'publisher.reactivated',
        target: input.publisher_id,
        reason,
        detail: { from: current, to: input.status },
      });
      return ok({ status: input.status });
    });
  } catch (e) {
    if (e instanceof Refused) return fail(e.code);
    throw e;
  }
}
