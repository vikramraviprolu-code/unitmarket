import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../../server/access';
import { currentActor } from '../../../../server/session';
import { EnvLabel } from '../../../../ui/EnvLabel';
import { formatDateTime, formatMinor, optionLabel } from '../../../../lib/format';
import {
  BACK_TO_OFFERS,
  DRAFT_NOTICE,
  FREEZE_NOTE,
  HISTORY_HEADING,
  LABEL_ARTICLE,
  LABEL_CURRENCY,
  LABEL_LICENCE,
  LABEL_STATUS,
  LABEL_TERMS,
  LABEL_VERSION,
  LABEL_WINDOW,
  OFFER_LEDE,
  WINDOW_VALUE,
  WITHDRAWN_NOTICE,
  historyLine,
  licenceText,
  offerStatusText,
  offeredLabel,
  priceHint,
  priceInputValue,
  priceLabel,
} from '../../../../lib/offer-copy';
import { OfferForm, WithdrawForm } from './OfferForm';

export const metadata: Metadata = { title: 'Change an offer' };

const OPTIONS = ['keep_retrieve', 'online_read'] as const;

// PUB-B (S3): one offer of the signed-in publisher. The only thing read from the address is the offer
// id, and it is asked for as the session actor: another publisher's offer and a guessed id both answer
// 404. The form sends the offer id and the version it was opened at; the route sends no publisher id.
export default async function PublisherOffer({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  const here = `/publisher/offers/${encodeURIComponent(id)}`;
  if (actor?.kind !== 'publisher') redirect(`/signin?next=${encodeURIComponent(here)}`);
  const o = await (await app()).engine.offers.get(actor, id);
  if (o === null) notFound();
  const live = o.status === 'authorised';
  const rows = OPTIONS.map((option) => {
    const current = o.options.find((p) => p.option === option);
    return {
      option,
      offeredLabel: offeredLabel(option),
      priceLabel: priceLabel(option, o.currency),
      offered: current !== undefined,
      price: current === undefined ? '' : priceInputValue(current.price_minor),
    };
  });
  return (
    <>
      <p>
        <Link href="/publisher/offers">{BACK_TO_OFFERS}</Link>
      </p>
      <h1>
        {o.article_title} <EnvLabel environment={o.environment} />
      </h1>
      <p className="lede">{OFFER_LEDE}</p>
      <div className="card">
        <dl>
          <dt>{LABEL_ARTICLE}</dt>
          <dd data-testid="offer-article">{o.article_title}</dd>
          <dt>{LABEL_STATUS}</dt>
          <dd data-testid="offer-status">{offerStatusText(o.status)}</dd>
          <dt>{LABEL_VERSION}</dt>
          <dd data-testid="offer-version">{o.version}</dd>
          <dt>{LABEL_CURRENCY}</dt>
          <dd data-testid="offer-currency">{o.currency}</dd>
          <dt>{LABEL_WINDOW}</dt>
          <dd data-testid="offer-window">{WINDOW_VALUE}</dd>
          <dt>{LABEL_LICENCE}</dt>
          <dd data-testid="offer-licence">{licenceText(o.rights)}</dd>
          <dt>{LABEL_TERMS}</dt>
          <dd data-testid="offer-terms">{o.terms_version}</dd>
        </dl>
      </div>
      <p className="muted" data-testid="offer-freeze-note">
        {FREEZE_NOTE}
      </p>
      {live ? (
        <>
          <OfferForm
            offerId={o.offer_id}
            version={o.version}
            capMinor={o.offer_max_minor}
            hint={priceHint(formatMinor(1, o.currency), formatMinor(o.offer_max_minor, o.currency))}
            rows={rows}
          />
          <WithdrawForm offerId={o.offer_id} version={o.version} />
        </>
      ) : (
        <p role="status" className="muted" data-testid="offer-withdrawn-notice">
          <strong>{o.status === 'draft' ? DRAFT_NOTICE : WITHDRAWN_NOTICE}</strong>
        </p>
      )}
      <h2>{HISTORY_HEADING}</h2>
      <ul data-testid="offer-history">
        {o.history.map((h) => (
          <li key={h.version}>
            {historyLine({
              version: h.version,
              status: h.status,
              when: formatDateTime(h.created_at),
              prices: h.options.map(
                (p) => `${optionLabel(p.option)} ${formatMinor(p.price_minor, o.currency)}`,
              ),
            })}
          </li>
        ))}
      </ul>
    </>
  );
}
