// INT-UI0 / UI0.7: the reads of the operator Home tab, in one module so a Wave 2 lane that changes Home does
// not touch the other tabs. The read is the one /ops made before, unchanged: the operations snapshot. It goes
// through the one door (server/access); the page does the operator check before it calls this.
import type { Actor } from '@umsbx/contracts';
import { app } from '../server/access';
import type { OpsSnapshot } from '../server/access';

export type OperatorActor = Extract<Actor, { kind: 'operator' }>;

export interface OpsHomeRead {
  snap: OpsSnapshot;
  /** Sandbox mode with the Cloud Run connection flag off: the switch can be On and still no call goes out. */
  flagOff: boolean;
}

/** Null when the snapshot refuses the session; the page then sends the visitor to sign in. */
export async function readOpsHome(actor: OperatorActor): Promise<OpsHomeRead | null> {
  const snap = await (await app()).engine.opsSnapshot(actor);
  if (snap === null) return null;
  return { snap, flagOff: snap.gate.mode === 'sandbox' && !snap.gate.connect };
}

// INT-AL: the alert and case reads of the operator pages (Needs you, the alert list and detail, the case queue
// and detail). They run over the engine's read methods, so a page never reaches the domain packages. The case
// detail is the one read that carries the text of the message to the buyer; it needs an operator.
type Reads = Awaited<ReturnType<typeof app>>['engine']['opsReads'];

export async function readNeedsYou(): Promise<Awaited<ReturnType<Reads['needsYou']>>> {
  return (await app()).engine.opsReads.needsYou();
}
export async function readAlertList(
  q: Parameters<Reads['alerts']>[0],
): Promise<Awaited<ReturnType<Reads['alerts']>>> {
  return (await app()).engine.opsReads.alerts(q);
}
export async function readAlertDetail(id: string): Promise<Awaited<ReturnType<Reads['alert']>>> {
  return (await app()).engine.opsReads.alert(id);
}
export async function readCaseQueue(
  q: Parameters<Reads['cases']>[0],
): Promise<Awaited<ReturnType<Reads['cases']>>> {
  return (await app()).engine.opsReads.cases(q);
}
export async function readCaseDetail(actor: OperatorActor, id: string) {
  return (await app()).engine.opsCases.detail(actor, id);
}
