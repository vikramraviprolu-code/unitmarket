import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { currentActor } from '../../../../../server/session';
import { readCasePage } from '../../../../../composition/ops-buyers';
import { PageHeader } from '../../../../../ui/publisher/kit';
import { CaseCard } from '../../../../../ui/ops/CaseCard';
import { caseDetailView } from '../../../../../lib/ops-cases-view';
import '../../../../publisher/pk-sales.css';
import '../../../pk-opshome.css';

export const metadata: Metadata = { title: 'Case' };

// INT-OPS-A / OPS-A.5: one case. Operators only; one without the authenticator code reads it and sees every button
// off. The single-use keys of the buttons are made here, on the server.
export default async function OpsCase({ params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/buyers/cases');
  const { id } = await params;
  const page = await readCasePage(actor, id);
  if (page === null) notFound();
  const view = caseDetailView(page.detail, { mfa: actor.mfa === true, keys: page.keys });
  return (
    <>
      <PageHeader title={`Case: ${view.kind_word}`} lede={`${view.state_word}, due ${view.sla_text}.`} />
      <p>
        <Link href="/ops/buyers/cases">All cases</Link>
      </p>
      <CaseCard view={view} />
    </>
  );
}
