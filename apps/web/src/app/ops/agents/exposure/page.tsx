import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../../../server/session';
import { readExposure } from '../../../../composition/ops-agents';
import { mintKeys } from '../../../../composition/ops-controls';
import { exposureView } from '../../../../lib/exposure-view';
import { PageHeader, Section } from '../../../../ui/publisher/kit';
import { ExposureTable } from '../../../../ui/ops/ExposureTable';
import '../../pk-opshome.css';

export const metadata: Metadata = { title: 'API exposure' };

// INT-CTL / CTL.7: which API groups partners can reach. Read from the api_exposure table, never from the
// journal. The name of the last operator shows only to a session with the authenticator code.
export default async function OpsApiExposure() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/agents/exposure');
  const rows = await readExposure(actor);
  if (rows === null) redirect('/signin?next=/ops/agents/exposure');
  const lines = exposureView(rows, { mfa: actor.mfa === true });
  const keys = await mintKeys(lines.length);
  return (
    <>
      <PageHeader
        title="API exposure"
        lede="Close a group to stop partners reaching it. Closing needs no authenticator code; opening again does."
      />
      <Section title="API groups" id="ops-exposure">
        <ExposureTable lines={lines} keys={keys} />
      </Section>
    </>
  );
}
