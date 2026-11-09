import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../../server/access';
import { currentActor } from '../../../../server/session';
import { EmptyState } from '../../../../ui/EmptyState';
import { EnvLabel } from '../../../../ui/EnvLabel';
import { PageHeader } from '../../../../ui/publisher/kit';
import { formatMinor, optionLabel } from '../../../../lib/format';
import { ATTEST_LABEL, offeredLabel, priceHint, priceLabel } from '../../../../lib/offer-copy';
import {
  CREATE_BACK,
  CREATE_HEADING,
  CREATE_LEDE,
  CREATE_NONE_BODY,
  CREATE_NONE_TITLE,
  CREATE_TERMS_NOTE,
  createErrorText,
} from '../../../../lib/publisher-e1-copy';
import { CreateForm } from './CreateForm';
import '../../pk-forms.css';

export const metadata: Metadata = { title: 'Create an offer' };

const OPTIONS = ['keep_retrieve', 'online_read'] as const;

// PUB-E1: put an own article without an offer on sale. The publisher is the one in the session and nowhere
// else: the page reads no input, and the engine lists only that publisher's articles. The form sends the
// article id, the options with their prices and the tick; the route and the domain check everything again.
export default async function NewOffer() {
  const actor = await currentActor();
  if (actor?.kind !== 'publisher') redirect('/signin?next=/publisher/offers/new');
  const view = await (await app()).engine.offers.offerable(actor);
  if (view === null) redirect('/signin?next=/publisher/offers/new');
  return (
    <>
      <p className="pk-back">
        <Link href="/publisher/offers">{CREATE_BACK}</Link>
      </p>
      <PageHeader
        title={CREATE_HEADING}
        lede={CREATE_LEDE}
        aside={<EnvLabel environment={view.environment} />}
      />
      {view.currency === null ? (
        <EmptyState title={CREATE_NONE_TITLE}>{createErrorText('no_corridor')}</EmptyState>
      ) : view.articles.length === 0 ? (
        <EmptyState title={CREATE_NONE_TITLE}>{CREATE_NONE_BODY}</EmptyState>
      ) : (
        <CreateForm
          articles={view.articles.map((a) => ({ id: a.article_id, title: a.title }))}
          capMinor={view.offer_max_minor}
          currencies={view.currencies.map((code) => ({
            code,
            hint: priceHint(formatMinor(1, code), formatMinor(view.offer_max_minor, code)),
            rows: OPTIONS.map((option) => ({
              option,
              offeredLabel: offeredLabel(option),
              priceLabel: priceLabel(option, code),
              optionName: optionLabel(option),
            })),
          }))}
          attestLabel={ATTEST_LABEL}
          terms={CREATE_TERMS_NOTE(view.terms_version)}
        />
      )}
    </>
  );
}
