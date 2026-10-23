// Operator or rule credit. A credit only adds time; it never reduces ends_at.
import type { Actor, CoreDeps, Id, Result, SqlExecutor, WindowState } from '@umsbx/contracts';
import { err, ok } from '@umsbx/contracts';
import { computeWindow } from './compute';
import { insertEvent, loadEvents, materialise, requireEntitlement } from './events';

export async function grantCredit(
  tx: SqlExecutor,
  d: CoreDeps,
  i: { entitlement_id: Id; credit_ms: number; case_id: Id; by: Actor },
): Promise<
  Result<WindowState, { code: 'credit_must_be_positive' | 'window_not_started' | 'window_ended' }>
> {
  // Only an operator or the system (a rule) may grant time; a buyer or publisher never can.
  if (i.by.kind !== 'operator' && i.by.kind !== 'system') {
    throw new Error(`actor ${i.by.kind} may not grant access credit`);
  }
  const head = await requireEntitlement(tx, i.entitlement_id);
  if (!Number.isSafeInteger(i.credit_ms) || i.credit_ms <= 0) {
    return err({ code: 'credit_must_be_positive' });
  }
  const current = computeWindow(await loadEvents(tx, head.id), head.policy, d.clock.now());
  if (current.state === 'not_started') return err({ code: 'window_not_started' });
  // An ended or revoked window is history: a credit now would change nothing (compute skips it, and
  // stops at the first revoke) yet look granted. Nothing is written (CO-5 R3, ASM-59).
  if (current.state === 'ended' || current.state === 'revoked') {
    return err({ code: 'window_ended' });
  }
  await insertEvent(tx, d, {
    entitlement_id: head.id,
    kind: 'credit_granted',
    link_id: null,
    source: i.by.kind === 'operator' ? 'operator' : 'system',
    evidence: { credit_ms: i.credit_ms, case_id: i.case_id, by: i.by.kind },
  });
  return ok(await materialise(tx, d, head));
}
