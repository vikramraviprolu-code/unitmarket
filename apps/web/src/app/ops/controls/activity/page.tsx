import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../../../server/session';
import { readOpsControls } from '../../../../composition/ops-controls';
import { EnvLabel } from '../../../../ui/EnvLabel';
import { PageHeader } from '../../../../ui/publisher/kit';
import { ActivityTable } from '../../../../ui/ops/ActivityTable';
import { rawFromSearchParams } from '../../../../lib/filter-bar-view';
import '../../pk-opshome.css';
import '../../../tables.css';
import '../../../publisher/pk-sales.css';

export const metadata: Metadata = { title: 'Activity' };

// INT-OPS-B / OPS-B.4: who did what, when and from where. The page is a shell: it checks the sign-in and mounts
// the table, which reads GET /api/ops/activity in the browser. Without the second factor the rows hold no
// identity and the actor filter is not offered; with it they show the operator and whether the code was used.
export default async function OpsActivity({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/controls/activity');
  const read = await readOpsControls(actor);
  if (read === null) redirect('/signin?next=/ops/controls/activity');
  const raw = rawFromSearchParams(await searchParams);
  return (
    <>
      <PageHeader
        title="Activity"
        aside={<EnvLabel environment={read.snap.environment} />}
        lede="Every change in the record, newest first. The switch history preset shows who turned a safety switch on or off."
      />
      <ActivityTable raw={raw} mfa={actor.mfa} />
    </>
  );
}
