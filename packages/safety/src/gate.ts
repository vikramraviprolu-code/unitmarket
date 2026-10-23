import type {
  Clock,
  Database,
  GateVerdict,
  OutboundGate,
  PayPalOperation,
  SwitchReader,
} from '@umsbx/contracts';
import { findActiveApproval, reserveCall } from './budget';

// Structural copy of Pick<Config, ...>: lint lets safety import contracts and transport only.
export interface GateConfig {
  mode: 'offline' | 'sandbox';
  connect: boolean;
  outbound_approval_ref: string | null;
}

// Operations that move money. A null amount on one of these is never allowed through: the cap
// would be skipped (FIX-BPREP M4). capture_order carries no amount of its own (the order was capped
// when it was created); it is limited by the daily call count and, when the caller supplies the
// order's expected amount, by the same per-order cap.
const MONEY_MOVING: ReadonlySet<PayPalOperation> = new Set(['create_order', 'refund_capture']);

// Gates built by createOutboundGate. The approval minter (claimed in scoped-gate.ts) mints only
// for a gate in this set, so an object literal with a `check` function is refused (SEAL2 H1).
// Module-private; the package index does not export the predicate.
// The WeakSet methods and Reflect.apply as they are when this module loads, so code that later
// replaces WeakSet.prototype.has or add cannot vouch for a fake gate (FIX-MVPB-SEAL3).
const apply = Reflect.apply;
const wsHas = WeakSet.prototype.has;
const wsAdd = WeakSet.prototype.add;
const issued = new WeakSet<object>();
export const isIssuedGate = (g: unknown): boolean =>
  typeof g === 'object' && g !== null && apply(wsHas, issued, [g]) === true;

// Decides whether a PayPal call may leave the process. First failing check wins (lane 02):
// connect_off, kill_switch, no_approval, budget. Any read error blocks (fail closed). An allowed
// verdict has reserved one call of the approval's daily budget: call check() once per request.
export function createOutboundGate(d: {
  db: Database;
  clock: Clock;
  switches: SwitchReader;
  config: GateConfig;
  /**
   * Scoped use (createScopedGate): the request must name this scope and the configured approval
   * ref, or it is blocked no_approval. Without it, scope and approval_ref are checked only when the
   * caller supplies them.
   */
  bind?: { scope: string };
}): OutboundGate {
  const gate: OutboundGate = {
    async check(c): Promise<GateVerdict> {
      const block = (
        by: 'connect_off' | 'kill_switch' | 'no_approval' | 'budget',
      ): GateVerdict => ({
        allowed: false,
        by,
      });
      if (d.config.mode !== 'sandbox' || !d.config.connect) return block('connect_off');
      try {
        if (!(await d.switches.isOn('paypal_outbound'))) return block('kill_switch');
        const ref = d.config.outbound_approval_ref;
        if (ref === null || ref === '') return block('no_approval');
        const now = d.clock.now();
        const row = await findActiveApproval(d.db, ref, now);
        if (row === null || !row.operations.includes(c.operation)) return block('no_approval');
        // M2: the request stands on this row and this scope, or it is blocked.
        if (d.bind !== undefined) {
          if (c.scope !== d.bind.scope || c.approval_ref !== row.approval_ref)
            return block('no_approval');
        }
        if (c.scope !== undefined && c.scope !== row.scope) return block('no_approval');
        if (c.approval_ref !== undefined && c.approval_ref !== row.approval_ref)
          return block('no_approval');
        // M4: a money-moving post must carry the amount it moves.
        if (c.amount_minor === null && MONEY_MOVING.has(c.operation)) return block('budget');
        if (c.amount_minor !== null && c.amount_minor > row.max_amount_minor)
          return block('budget');
        // Review 4 H3: the budget is reserved here, not just read (see budget.ts).
        const reservation = await reserveCall(
          d.db,
          { approval_ref: row.approval_ref, operation: c.operation, amount_minor: c.amount_minor },
          now,
        );
        if (reservation === 'budget') return block('budget');
        if (reservation === 'no_approval') return block('no_approval');
        return { allowed: true, approval_ref: row.approval_ref };
      } catch {
        return block('kill_switch');
      }
    },
  };
  Object.freeze(gate);
  apply(wsAdd, issued, [gate]);
  return gate;
}
