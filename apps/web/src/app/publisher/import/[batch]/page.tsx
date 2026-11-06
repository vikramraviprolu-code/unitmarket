import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../../server/access';
import { currentActor } from '../../../../server/session';
import { EnvLabel } from '../../../../ui/EnvLabel';
import { PageHeader } from '../../../../ui/publisher/kit';
import { BACK_LINK, REVIEW_HEADING, REVIEW_LEDE } from '../../../../lib/web-import-copy';
import { ReviewList } from './ReviewList';
import '../../pk-forms.css';

export const metadata: Metadata = { title: 'Review your import' };

// POB-I1 (D-089, J8 and J9): the staged list of one batch. The batch id is the only parameter read; the
// engine answers only for the publisher in the session, and another publisher's batch is not found.
export default async function PublisherImportBatch({
  params,
}: {
  params: Promise<{ batch: string }>;
}) {
  const { batch } = await params;
  const actor = await currentActor();
  if (actor?.kind !== 'publisher')
    redirect(`/signin?next=/publisher/import/${encodeURIComponent(batch)}`);
  const view = await (await app()).engine.webImport.review({ actor, batch_id: batch });
  if (view === null) notFound();
  return (
    <>
      <p className="pk-back">
        <Link href="/publisher/import">{BACK_LINK}</Link>
      </p>
      <PageHeader
        title={REVIEW_HEADING}
        lede={REVIEW_LEDE}
        aside={<EnvLabel environment={view.environment} />}
      />
      <ReviewList
        initial={{ batch: view.batch, items: view.items }}
        offerMaxMinor={view.offer_max_minor}
      />
    </>
  );
}
