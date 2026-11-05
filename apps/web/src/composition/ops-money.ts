// INT-UI0 / UI0.7: the reads of the operator Money tab: the operations snapshot, one single-use
// Idempotency-Key per refund form (made on the server, CO-8), and the reporting view, which converts only
// through the engine at the latest stored rate (MC2-L7). These are the reads /ops made before, unchanged.
import type { Actor } from '@umsbx/contracts';
import { app } from '../server/access';
import type { OpsSnapshot } from '../server/access';
import { opsReportingView } from '../lib/ops-reporting-view';

type OperatorActor = Extract<Actor, { kind: 'operator' }>;

export interface OpsMoneyRead {
  snap: OpsSnapshot;
  refundKeys: string[];
  reporting: ReturnType<typeof opsReportingView>;
}

export async function readOpsMoney(actor: OperatorActor): Promise<OpsMoneyRead | null> {
  const a = await app();
  const snap = await a.engine.opsSnapshot(actor);
  if (snap === null) return null;
  const refundKeys = snap.refunds === null ? [] : snap.refunds.units.map(() => a.engine.newKey());
  const reporting = opsReportingView(snap.totals, {
    convert: a.engine.fx.convert,
    rates: await a.engine.fx.getRates(),
  });
  return { snap, refundKeys, reporting };
}

// INT-OPS-B / OPS-B.2: the props of the Transactions page, and nothing else. The list itself comes from
// GET /api/ops/transactions in the browser (SR1), so the cursor hash and the MFA rule stay in the route. The
// environment is the app's stored one, for the label; `mfa` only says which fields the filter bar may offer.
export interface OpsTransactionsProps {
  environment: OpsSnapshot['environment'];
  mfa: boolean;
}

export async function readOpsTransactionsProps(
  actor: OperatorActor,
): Promise<OpsTransactionsProps | null> {
  const snap = await (await app()).engine.opsSnapshot(actor);
  return snap === null ? null : { environment: snap.environment, mfa: actor.mfa };
}
