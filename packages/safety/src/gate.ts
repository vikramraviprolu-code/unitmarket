import type { Clock, Database, GateVerdict, OutboundGate, SwitchReader } from '@umsbx/contracts';
import { callsToday, findActiveApproval } from './budget';

// Structural copy of Pick<Config, ...>: lint lets safety import contracts and transport only.
export interface GateConfig {
  mode: 'offline' | 'sandbox';
  connect: boolean;
  outbound_approval_ref: string | null;
}

// Decides whether a PayPal call may leave the process. First failing check wins (lane 02):
// connect_off, kill_switch, no_approval, budget. Any read error blocks (fail closed).
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
        if ((await callsToday(d.db, now)) >= row.max_calls_per_day) return block('budget');
        return { allowed: true, approval_ref: row.approval_ref };
      } catch {
        return block('kill_switch');
      }
    },
  };
}
