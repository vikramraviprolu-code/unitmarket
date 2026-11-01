import { err, ok } from '@umsbx/contracts';
import type { Actor, AuditSink, Clock, Database, Result } from '@umsbx/contracts';
import { findActiveApproval } from './budget';
import type { ApprovalRow } from './budget';
import { checkOperatorTerminal } from './cli-approve';
import { readSafetyStatus } from './status';
import { setSwitch } from './switches';

/** Why the shared check refuses. Every one of these is also an answer of the Start button (WEB-OPS-START). */
export type ResumeCoreError =
  | 'reason_required'
  | 'operator_required'
  | 'no_active_approval'
  | 'scope_mismatch'
  | 'budget_used_up'
  | 'already_on'
  | 'scope_not_confirmed'
  | 'switch_locked';

export type ResumeError = 'not_a_tty' | 'ci_set' | 'ai_session' | ResumeCoreError;

// Environment markers of an AI coding session (the same two the spike kit refuses on).
const AI_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_REMOTE',
  'AI_AGENT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
] as const;
// CI markers beyond the plain CI flag that checkOperatorTerminal reads.
const CI_MARKERS = ['GITHUB_ACTIONS'] as const;
const set = (v: string | undefined): boolean => v !== undefined && v !== '';

/**
 * The one check behind `pnpm safety:resume` and the Operations "Start PayPal" button (WEB-OPS-START).
 * Both call this; neither has a copy. In order: a reason, an operator with the second factor, an active
 * approval row for the configured reference and for the scope the app serves, calls left for the day,
 * (when asked) a switch that is still off, then `confirm` (the person typed the scope back), and only
 * then setSwitch, in one transaction with its own audit row and a `safety.resume` row. It never
 * inserts an approval and never touches the connect flag.
 */
export async function resumeOutbound(d: {
  db: Database;
  clock: Clock;
  audit: AuditSink;
  /** Must be an operator with mfa: the terminal (ASM-31) and the web sign-in with a code (CO-6) both give that. */
  by: Actor;
  reason: string;
  /** UMS_OUTBOUND_APPROVAL_REF */
  approval_ref: string | null;
  /** UMS_OUTBOUND_SCOPE: the scope the app serves */
  scope: string;
  /** True: an already-on switch is refused (a replayed press must not write a second audit row). */
  refuse_if_on?: boolean;
  /** Called with the active row once every check has passed; false means the scope was not confirmed. */
  confirm: (row: ApprovalRow) => boolean | Promise<boolean>;
}): Promise<
  Result<
    { approval_ref: string; scope: string; calls_left: number; valid_until: string },
    ResumeCoreError
  >
> {
  const reason = d.reason.trim();
  if (reason === '') return err('reason_required');
  if (d.by.kind !== 'operator' || !d.by.mfa) return err('operator_required');
  const ref = d.approval_ref === null ? '' : d.approval_ref.trim();
  if (ref === '') return err('no_active_approval');
  const now = d.clock.now();
  const row = await findActiveApproval(d.db, ref, now);
  if (row === null) return err('no_active_approval');
  if (row.scope !== d.scope) return err('scope_mismatch');
  const status = await readSafetyStatus(d.db, now, ref);
  if (status.budget === null) return err('no_active_approval');
  if (status.budget.remaining_today <= 0) return err('budget_used_up');
  if (d.refuse_if_on === true && status.switches.some((x) => x.name === 'paypal_outbound' && x.on))
    return err('already_on');
  if (!(await d.confirm(row))) return err('scope_not_confirmed');
  let r: Awaited<ReturnType<typeof setSwitch>>;
  try {
    r = await setSwitch(d.db, d.audit, d.clock, {
      name: 'paypal_outbound',
      on: true,
      by: d.by,
      reason,
      approval_ref: row.approval_ref,
      also_audit: {
        action: 'safety.resume',
        target: row.approval_ref,
        detail: { approval_ref: row.approval_ref, scope: row.scope },
      },
    });
  } catch {
    // The database refused the change (the transaction rolled back): the switch is held off by
    // something outside this check. Nothing was turned on and no audit row was left behind.
    return err('switch_locked');
  }
  // The row can expire between the read above and the transaction: setSwitch checks it again.
  if (!r.ok) {
    if (r.error === 'approval_not_active') return err('no_active_approval');
    return err(r.error === 'operator_required' ? 'operator_required' : 'reason_required');
  }
  return ok({
    approval_ref: row.approval_ref,
    scope: row.scope,
    calls_left: status.budget.remaining_today,
    valid_until: status.budget.valid_until,
  });
}

/**
 * `pnpm safety:resume` (BU-2, O-B6): turns paypal_outbound back on. setSwitch needs an operator with a
 * second factor. The web sign-in gives one only with a right authenticator code (CO-6); the Operations
 * "Start PayPal" button (WEB-OPS-START) uses that and runs the same `resumeOutbound` check as this command.
 * The owner at a terminal on their own machine, with an active approval row for the configured
 * reference and the scope typed back, counts as that second factor (the same basis as safety:approve,
 * ASM-31). On the host it runs in the Render shell while the app is in maintenance mode (D-037, CO-7b).
 *
 * Refuses, before it asks anything, without a terminal, in CI, and in an AI session. Then
 * `resumeOutbound`: the approval row for the configured ref must be active now, be for the scope the app
 * serves and have calls left today; the owner must type that scope; only then does setSwitch run, as an
 * operator with mfa, in one transaction with its audit rows.
 */
export async function runResume(d: {
  db: Database;
  clock: Clock;
  audit: AuditSink;
  tty: { isTTY: boolean | undefined; env: Record<string, string | undefined> };
  ask: (prompt: string) => Promise<string>;
  write: (line: string) => void;
  operator_id: string;
  /** UMS_OUTBOUND_APPROVAL_REF */
  approval_ref: string | null;
  /** UMS_OUTBOUND_SCOPE: the scope the app serves */
  scope: string;
  reason: string;
}): Promise<Result<{ approval_ref: string; scope: string }, ResumeError>> {
  const term = checkOperatorTerminal(d.tty);
  if (!term.ok) return term;
  if (CI_MARKERS.some((n) => set(d.tty.env[n]))) return err('ci_set');
  if (AI_MARKERS.some((n) => set(d.tty.env[n]))) return err('ai_session');
  const r = await resumeOutbound({
    db: d.db,
    clock: d.clock,
    audit: d.audit,
    by: { kind: 'operator', operator_id: d.operator_id, mfa: true },
    reason: d.reason,
    approval_ref: d.approval_ref,
    scope: d.scope,
    confirm: async (row) => {
      d.write(
        `Turning paypal_outbound on for approval ${row.approval_ref}: scope ${row.scope}, ${row.max_calls_per_day} calls a day, up to ${row.max_amount_minor} minor units per order.`,
      );
      const typed = await d.ask(`Type the scope name (${row.scope}) to confirm: `);
      return typed.trim() === row.scope;
    },
  });
  if (!r.ok) return r;
  return ok({ approval_ref: r.value.approval_ref, scope: r.value.scope });
}
