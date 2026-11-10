import { err, ok } from '@umsbx/contracts';
import type { Actor, AuditSink, Clock, Database, PayPalOperation, Result } from '@umsbx/contracts';
import { SITTING_SEP, findActiveApproval } from './budget';

/**
 * OPS-SW (D-118): the D-094 ceiling of one PayPal sandbox sitting, fixed in code. The console cannot
 * widen it: the five read-and-pay operations only (no refunds, webhooks or payouts), at most 500 minor
 * units per order, at most 40 calls, at most four hours.
 */
export const SITTING_CEILING: Readonly<{
  operations: readonly PayPalOperation[];
  max_amount_minor: number;
  max_calls: number;
  valid_ms: number;
}> = Object.freeze({
  operations: Object.freeze([
    'oauth_token',
    'create_order',
    'get_order',
    'capture_order',
    'get_capture',
  ] as PayPalOperation[]),
  max_amount_minor: 500,
  max_calls: 40,
  valid_ms: 4 * 3_600_000,
});

export type SittingError =
  'reason_required' | 'operator_required' | 'no_reference' | 'sitting_active';

/** 2026-11-10T04:00:00.000Z becomes 20261110T040000Z. */
const stamp = (d: Date): string =>
  d
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');

/**
 * OPS-SW (D-118): "Open a PayPal sitting" on Operations Controls. Writes the approval row that
 * `pnpm safety:approve` writes at the owner's terminal, for an operator who signed in WITH the
 * authenticator code, under `<base_ref>~<UTC stamp>` with SITTING_CEILING. One sitting at a time: an
 * active approval under the configured reference (console or terminal) is refused. It does not turn
 * paypal_outbound on (Start does, with its own checks) and it never touches the connect flag.
 */
export async function openSitting(d: {
  db: Database;
  clock: Clock;
  audit: AuditSink;
  by: Actor;
  /** Why the sitting is opened, in the operator's words; kept on the audit row. */
  reason: string;
  /** UMS_OUTBOUND_APPROVAL_REF */
  base_ref: string | null;
  /** UMS_OUTBOUND_SCOPE: the scope the app serves */
  scope: string;
}): Promise<
  Result<
    {
      approval_ref: string;
      scope: string;
      valid_until: string;
      max_amount_minor: number;
      max_calls: number;
    },
    SittingError
  >
> {
  const reason = d.reason.trim();
  if (reason === '') return err('reason_required');
  const by = d.by;
  if (by.kind !== 'operator' || by.mfa !== true) return err('operator_required');
  const base = d.base_ref === null ? '' : d.base_ref.trim();
  if (base === '') return err('no_reference');
  const now = d.clock.now();
  const approval_ref = `${base}${SITTING_SEP}${stamp(now)}`;
  const valid_until = new Date(now.getTime() + SITTING_CEILING.valid_ms).toISOString();
  const at = now.toISOString();
  const inserted = await d.db.transaction(async (tx) => {
    // Two presses at once: the second waits on this lock and then sees the first sitting.
    await tx.query(`SELECT 1 FROM safety_switches WHERE name = 'paypal_outbound' FOR UPDATE`);
    if ((await findActiveApproval(tx, base, now)) !== null) return false;
    await tx.query(
      `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [
        `oap_${approval_ref}`,
        approval_ref,
        d.scope,
        [...SITTING_CEILING.operations],
        SITTING_CEILING.max_amount_minor,
        SITTING_CEILING.max_calls,
        valid_until,
        `${by.operator_id} (console)`,
        at,
      ],
    );
    await d.audit.record(tx, {
      actor: by,
      action: 'outbound_approval.create',
      target: null,
      reason,
      detail: { approval_ref, scope: d.scope, valid_until, source: 'console' },
    });
    return true;
  });
  if (!inserted) return err('sitting_active');
  return ok({
    approval_ref,
    scope: d.scope,
    valid_until,
    max_amount_minor: SITTING_CEILING.max_amount_minor,
    max_calls: SITTING_CEILING.max_calls,
  });
}
