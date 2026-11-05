// INT-UI0 / UI0.7: the reads of the operator Controls tab: the safety switches and the outbound approval
// gate, from the operations snapshot, as /ops read them before. Reading is all it does: the start and stop
// buttons stay on Home, and nothing here sets UMS_PAYPAL_CONNECT or touches outbound_approvals.
import type { Actor } from '@umsbx/contracts';
import { app } from '../server/access';
import type { OpsSnapshot } from '../server/access';

type OperatorActor = Extract<Actor, { kind: 'operator' }>;

export interface OpsControlsRead {
  snap: OpsSnapshot;
  /** Sandbox mode with the Cloud Run connection flag off: the switch can be On and still no call goes out. */
  flagOff: boolean;
}

export async function readOpsControls(actor: OperatorActor): Promise<OpsControlsRead | null> {
  const snap = await (await app()).engine.opsSnapshot(actor);
  if (snap === null) return null;
  return { snap, flagOff: snap.gate.mode === 'sandbox' && !snap.gate.connect };
}
