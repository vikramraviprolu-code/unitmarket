// The body of `pnpm accounts:reset-password --username <name>` (ID-ACCOUNTS), modelled on safety:approve and
// the privacy script: a person's terminal only, never in CI or an AI session, the new password asked twice
// with echo off, the same password policy as signup, the account's sessions ended, one audit row. The
// prompts are injected, so a test scripts them; this function never prints a password.
import { resetPasswordForOperator } from './accounts';
import type { PasswordRefusal } from './accounts';
import type { SecurityDeps } from './route';

const CI_MARKERS = ['CI', 'GITHUB_ACTIONS'] as const;
const AI_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_REMOTE',
  'AI_AGENT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
] as const;
const set = (v: string | undefined): boolean => v !== undefined && v !== '';

export type ResetCliError =
  | 'not_a_tty'
  | 'ci_set'
  | 'ai_session'
  | 'operator_required'
  | 'mismatch'
  | 'unknown_account'
  | 'weak_password';

export type ResetCliResult =
  | { ok: true; value: { revoked: number } }
  | { ok: false; error: ResetCliError; reason?: PasswordRefusal };

export async function runResetPassword(d: {
  deps: SecurityDeps;
  tty: { isTTY: boolean | undefined; env: Record<string, string | undefined> };
  operator_id: string;
  username: string;
  /** Asks for a secret with the typed characters hidden. */
  askSecret: (prompt: string) => Promise<string>;
  write: (line: string) => void;
}): Promise<ResetCliResult> {
  if (CI_MARKERS.some((n) => set(d.tty.env[n]))) return { ok: false, error: 'ci_set' };
  if (AI_MARKERS.some((n) => set(d.tty.env[n]))) return { ok: false, error: 'ai_session' };
  if (d.tty.isTTY !== true) return { ok: false, error: 'not_a_tty' };
  if (d.operator_id.trim() === '') return { ok: false, error: 'operator_required' };
  d.write(`Setting a new password for the account ${d.username}. All its sessions will end.`);
  const first = await d.askSecret('New password: ');
  const second = await d.askSecret('Repeat the new password: ');
  if (first !== second) return { ok: false, error: 'mismatch' };
  const r = await resetPasswordForOperator(d.deps, {
    username: d.username,
    new_password: first,
    operator_id: d.operator_id.trim(),
  });
  if (!r.ok)
    return r.code === 'weak_password'
      ? { ok: false, error: 'weak_password', reason: r.reason }
      : { ok: false, error: 'unknown_account' };
  return { ok: true, value: { revoked: r.revoked } };
}
