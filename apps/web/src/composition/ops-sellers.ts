// INT-UI0 / UI0.7: the reads of the operator Sellers tab. Today it shows the shared payee line, which comes
// from the operations snapshot. OPS-C adds the publisher and payee reads here, not in another tab's module.
import type { Actor } from '@umsbx/contracts';
import { app } from '../server/access';
import type { OpsSnapshot } from '../server/access';

type OperatorActor = Extract<Actor, { kind: 'operator' }>;

export interface OpsSellersRead {
  snap: OpsSnapshot;
}

export async function readOpsSellers(actor: OperatorActor): Promise<OpsSellersRead | null> {
  const snap = await (await app()).engine.opsSnapshot(actor);
  return snap === null ? null : { snap };
}
