import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../../../server/session';
import { readOpsControls, traceVerifyDetail } from '../../../../composition/ops-controls';
import { EnvLabel } from '../../../../ui/EnvLabel';
import { PageHeader, Section } from '../../../../ui/publisher/kit';
import { VerifyTile } from '../../../../ui/ops/VerifyTile';
import { verifyTileView } from '../../../../lib/verify-view';
import '../../pk-opshome.css';

export const metadata: Metadata = { title: 'Invariants' };

// INT-OPS-B / OPS-B.5: the trace verify tile. Verify runs only when the address carries ?verify=1 (the "Run
// verify" link), never on a normal render, and only for an operator session: a buyer or seller is sent to
// sign in before anything is read. The platform money invariants stay on Money, linked from the tile.
export default async function OpsInvariants({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/controls/invariants');
  const read = await readOpsControls(actor);
  if (read === null) redirect('/signin?next=/ops/controls/invariants');
  const { verify } = await searchParams;
  const detail = verify === '1' ? await traceVerifyDetail(actor) : null;
  const tile = verifyTileView(detail === null ? { state: 'idle' } : { state: 'ran', detail });
  return (
    <>
      <PageHeader
        title="Invariants"
        aside={<EnvLabel environment={read.snap.environment} />}
        lede="Checks that the record of what happened has not been changed. Run verify to compare every chain, seal and row."
      />
      <Section title="Journal verify" id="ops-trace-verify">
        <VerifyTile tile={tile} />
      </Section>
    </>
  );
}
