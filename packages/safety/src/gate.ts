import type { Clock, Database, GateVerdict, OutboundGate, SwitchReader } from '@umsbx/contracts';
import { findActiveApproval, reserveCall } from './budget';

// Structural copy of Pick<Config, ...>: lint lets safety import contracts and transport only.
export interface GateConfig {
  mode: 'offline' | 'sandbox';
  connect: boolean;
  outbound_approval_ref: string | null;
}

// Decides whether a PayPal call may leave the process. First failing check wins (lane 02):
// connect_off, kill_switch, no_approval, budget. Any read error blocks (fail closed). An allowed
// verdict has reserved one call of the approval's daily budget: call check() once per request.
export function createOutboundGate(d: {
  db: Database;
  clock: Clock;
  switches: SwitchReader;
  config: GateConfig;
}): OutboundGate {
  return {
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
}
