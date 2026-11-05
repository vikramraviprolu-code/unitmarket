// INT-SR1 (SR1.3, SR1.4, SR1.5): the one place that decides whether an operator answer carries identity.
// An operator API key always has `mfa: false` (toActor), and an operator session can GET without MFA, so the
// check is on the Actor, never on the route. With MFA: buyer and seller names and PayPal ids. Without: order
// refs, amounts, states, flags and opaque ids only. The session list, the session export and quick-find all
// go through here, and so does the key route, which therefore can never add identity.
import type { Actor } from '@umsbx/contracts';
import { opsLine } from '../../composition.server';
import type { FindResult } from '../../composition.server';

/** True for an operator session that signed in with the second factor. */
export const hasOpsIdentity = (actor: Actor): boolean => actor.kind === 'operator' && actor.mfa;

type Row = Record<string, unknown>;

/** Lines of the operator list for this actor. */
export function withOpsIdentity(actor: Actor, rows: readonly Row[], now: Date) {
  const identity = hasOpsIdentity(actor);
  return rows.map((r) => opsLine(r, now, identity));
}

/** Quick-find groups for this actor: the buyer group and every name only with MFA. */
export function findForActor(actor: Actor, found: FindResult): FindResult {
  if (hasOpsIdentity(actor)) return found;
  const { buyers: _buyers, ...rest } = found;
  void _buyers;
  return {
    ...rest,
    sellers: found.sellers.map(({ display_name: _n, ...s }) => {
      void _n;
      return s;
    }),
  };
}
