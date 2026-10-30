import { err, ok } from '@umsbx/contracts';
import type { AuditSink, Clock, Database, Result } from '@umsbx/contracts';
import { findActiveApproval } from './budget';
import { checkOperatorTerminal } from './cli-approve';
import { setSwitch } from './switches';

export type ResumeError =
  | 'not_a_tty'
  | 'ci_set'
  | 'ai_session'
  | 'reason_required'
  | 'no_active_approval'
  | 'scope_mismatch'
  | 'scope_not_confirmed';

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
 * `pnpm safety:resume` (BU-2, O-B6): turns paypal_outbound back on. setSwitch needs an operator with a
 * second factor. The web sign-in gives one only with a right authenticator code (CO-6), and no web
 * route turns the switch on (the ops button only stops), so in sandbox mode this command is the way.
 * The owner at a terminal on their own machine, with an active approval row for the configured
 * reference and the scope typed back, counts as that second factor (the same basis as safety:approve,
 * ASM-31). On the host it runs in the Render shell while the app is in maintenance mode (D-037, CO-7b).
 *
 * Refuses, before it asks anything, without a terminal, in CI, and in an AI session. Then:
 * the approval row for the configured ref must be active now and be for the scope the app serves;
 * the owner must type that scope; only then does setSwitch run, as an operator with mfa, in one
 * transaction with its audit row.
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
  const reason = d.reason.trim();
  if (reason === '') return err('reason_required');
  const ref = d.approval_ref === null ? '' : d.approval_ref.trim();
  if (ref === '') return err('no_active_approval');
  const row = await findActiveApproval(d.db, ref, d.clock.now());
  if (row === null) return err('no_active_approval');
  if (row.scope !== d.scope) return err('scope_mismatch');
  d.write(
    `Turning paypal_outbound on for approval ${row.approval_ref}: scope ${row.scope}, ${row.max_calls_per_day} calls a day, up to ${row.max_amount_minor} minor units per order.`,
  );
  const typed = await d.ask(`Type the scope name (${row.scope}) to confirm: `);
  if (typed.trim() !== row.scope) return err('scope_not_confirmed');
  const r = await setSwitch(d.db, d.audit, d.clock, {
    name: 'paypal_outbound',
    on: true,
    by: { kind: 'operator', operator_id: d.operator_id, mfa: true },
    reason,
    approval_ref: row.approval_ref,
  });
  // The row can expire between the read above and the transaction: setSwitch checks it again.
  if (!r.ok)
    return err(r.error === 'approval_not_active' ? 'no_active_approval' : 'reason_required');
  return ok({ approval_ref: row.approval_ref, scope: row.scope });
}
