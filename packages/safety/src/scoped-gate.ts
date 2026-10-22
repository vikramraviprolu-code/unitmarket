import { mintApprovalCapability } from '@umsbx/transport';
import type { ApprovalCapability } from '@umsbx/transport';
import type { Clock, Database, OutboundGate, SwitchReader } from '@umsbx/contracts';
import { findActiveApproval } from './budget';
import { createOutboundGate } from './gate';
import type { GateConfig } from './gate';

// The scoped gate (FIX-BPREP M3). It is the only place an approval capability is minted. The
// capability is handed out only while the outbound_approvals row for the configured ref exists,
// has the scope this gate was built for, has not expired, and the paypal_outbound switch is on
// (the switch is how an approval is revoked: rows are append-only, so there is no revoked flag).
// Nothing in composition calls this yet: the approved transport stays unreachable until the owner
// unseals it.
export interface ScopedGateHandle extends OutboundGate {
  /** Reads the approval row now. Null unless every condition above holds. */
  activeApproval(): Promise<{ scope: string; approval_ref: string } | null>;
  /** A capability for the approved transport factory, or null when activeApproval() is null. */
  approvalCapability(): Promise<ApprovalCapability | null>;
}

export function createScopedGate(
  db: Database,
  clock: Clock,
  o: { scope: string; switches: SwitchReader; config: GateConfig },
): ScopedGateHandle {
  if (typeof o.scope !== 'string' || o.scope === '') throw new TypeError('scope required');
  const inner = createOutboundGate({
    db,
    clock,
    switches: o.switches,
    config: o.config,
    bind: { scope: o.scope },
  });
  async function activeApproval(): Promise<{ scope: string; approval_ref: string } | null> {
    try {
      if (o.config.mode !== 'sandbox' || !o.config.connect) return null;
      const ref = o.config.outbound_approval_ref;
      if (ref === null || ref === '') return null;
      if (!(await o.switches.isOn('paypal_outbound'))) return null;
      const row = await findActiveApproval(db, ref, clock.now());
      if (row === null || row.scope !== o.scope) return null;
      return { scope: row.scope, approval_ref: row.approval_ref };
    } catch {
      return null;
    }
  }
  return {
    check: (c) => inner.check(c),
    activeApproval,
    async approvalCapability() {
      const a = await activeApproval();
      if (a === null) return null;
      return mintApprovalCapability({ scope: a.scope, approval_ref: a.approval_ref, gate: inner });
    },
  };
}
