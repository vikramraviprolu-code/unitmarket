import { redirect } from 'next/navigation';
import { currentActor } from '../../../server/session';

// INT-OPS-A / OPS-A.5: the Buyers tab opens on the case queue, the only buyer page of the operator so far.
export default async function OpsBuyers() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/buyers');
  redirect('/ops/buyers/cases');
}
