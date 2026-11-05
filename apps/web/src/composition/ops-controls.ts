// INT-UI0 / UI0.7: the reads of the operator Controls tab: the safety switches and the outbound approval
// gate, from the operations snapshot, as /ops read them before. Reading is all it does: the start and stop
// buttons stay on Home, and nothing here sets UMS_PAYPAL_CONNECT or touches outbound_approvals.
import type { Actor } from '@umsbx/contracts';
import { app, formatTraceFinding, verifyTrace } from '../server/access';
import type { OpsSnapshot } from '../server/access';
import type { TraceVerifyDetail } from '../lib/verify-view';

type ActivityInput = Parameters<Awaited<ReturnType<typeof app>>['trace']['activityPage']>[0];
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

// INT-TR1: the journal reads of the operator screens. Each is read only. `mfa` is true only for a session
// signed in with the second factor; an operator key always passes false.
export async function readOpsTimeline(order_ref: string, mfa: boolean) {
  return (await app()).trace.opsTimeline({ order_ref, mfa });
}

export async function readOpsActivity(o: ActivityInput) {
  return (await app()).trace.activityPage(o);
}

export async function readUnitEvidence(unit_id: string) {
  return (await app()).trace.evidencePack({ unit_id });
}

export async function readTraceVerify() {
  return (await app()).trace.verifyJournal();
}

export async function renderEvidenceHtml(
  p: NonNullable<Awaited<ReturnType<typeof readUnitEvidence>>>,
) {
  return (await app()).trace.evidenceHtml(p);
}

// INT-OPS-B / OPS-B.5: the detail behind the trace verify tile. It runs TR0's in-process verify (the same
// verifyTrace that `pnpm trace:verify` runs) on the app database and words each finding as TR0 prints it:
// `chain <key> seq <n>: ...` for a broken chain, head, seal or digest, and `drift <table> <id> <column>` for a
// row that no longer matches its events. Operator sessions only: any other actor gets null and the page never
// calls this for them (N-B2). The tile calls it only on ?verify=1, never on a plain page render. On Postgres it
// runs in one read only snapshot, as the script does; it writes nothing.
export async function traceVerifyDetail(actor: Actor): Promise<TraceVerifyDetail | null> {
  if (actor.kind !== 'operator') return null;
  const db = (await app()).db;
  const report =
    db.dialect === 'pg'
      ? await db.transaction(async (tx) => {
          await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
          return verifyTrace(tx);
        })
      : await verifyTrace(db);
  return {
    ok: report.findings.length === 0,
    chains: report.chains,
    rows: report.rows,
    seals: report.seals,
    lines: report.findings.map(formatTraceFinding),
  };
}
