// INT-UI0 / UI0.7: the reads of the operator Home tab, in one module so a Wave 2 lane that changes Home does
// not touch the other tabs. The read is the one /ops made before, unchanged: the operations snapshot. It goes
// through the one door (server/access); the page does the operator check before it calls this.
import type { Actor } from '@umsbx/contracts';
import { app } from '../server/access';
import type { OpsSnapshot } from '../server/access';
import { healthLights } from '../lib/ops-health-view';
import type { HealthLight } from '../lib/ops-health-view';
import { bellCounts, orderAnchor } from '../lib/ops-alerts-view';
import type { AlertActionKind, BellCounts } from '../lib/ops-alerts-view';

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

// INT-OPS-A / OPS-A.1: the four lights of Home. The facts are read by the engine (health check, stored switch,
// lock block, last job pass, injected clock); the rule that turns them into words is lib/ops-health-view.ts.
export async function readHomeLights(actor: Actor): Promise<HealthLight[]> {
  const h = await (await app()).engine.opsHealth(actor);
  if (h === null) return [];
  return healthLights(h);
}

// INT-OPS-A / OPS-A.2: the shell bell. Open alerts by severity, from AL's needs-you rows; it shows nothing else.
export async function readBellCounts(): Promise<BellCounts> {
  return bellCounts(await readNeedsYou());
}

// INT-OPS-A / OPS-A.3: one alert for its page: AL's detail, one single-use key per action (the browser cannot make
// one), and the anchor of the order timeline entry whose source is this alert. Null for a non operator and for an
// unknown alert. The timeline is read with the session's own second factor, so no identity is gained here.
export interface AlertPageRead {
  detail: NonNullable<Awaited<ReturnType<Reads['alert']>>>;
  order_anchor: string | null;
  keys: Record<AlertActionKind, string>;
}
export async function readAlertPage(actor: Actor, id: string): Promise<AlertPageRead | null> {
  if (actor.kind !== 'operator') return null;
  const a = await app();
  const detail = await a.engine.opsReads.alert(id);
  if (detail === null) return null;
  let anchor: string | null = null;
  if (detail.order_ref !== null) {
    const tl = await a.trace.opsTimeline({ order_ref: detail.order_ref, mfa: actor.mfa === true });
    anchor = tl === null ? null : orderAnchor(tl.entries, id);
  }
  const n = a.engine.newKey;
  return { detail, order_anchor: anchor, keys: { acknowledge: n(), resolve: n(), reopen: n() } };
}
