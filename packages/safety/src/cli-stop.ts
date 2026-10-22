import { err } from '@umsbx/contracts';
import type { Actor, AuditSink, Clock, Database, Result } from '@umsbx/contracts';
import { checkOperatorTerminal } from './cli-approve';
import { setSwitch } from './switches';

// `pnpm safety:stop`: paypal_outbound off, with a reason, from a person's terminal only.
export async function runStop(d: {
  db: Database;
  clock: Clock;
  audit: AuditSink;
  tty: { isTTY: boolean | undefined; env: Record<string, string | undefined> };
  by: Actor;
  reason: string;
}): Promise<Result<void, 'not_a_tty' | 'ci_set' | 'reason_required' | 'operator_required'>> {
  const term = checkOperatorTerminal(d.tty);
  if (!term.ok) return term;
  const r = await setSwitch(d.db, d.audit, d.clock, {
    name: 'paypal_outbound',
    on: false,
    by: d.by,
    reason: d.reason,
    approval_ref: null,
  });
  if (!r.ok) return err(r.error === 'operator_required' ? 'operator_required' : 'reason_required');
  return r;
}
