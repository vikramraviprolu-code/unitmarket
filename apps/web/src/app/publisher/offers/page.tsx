import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EmptyState } from '../../../ui/EmptyState';
import { EnvLabel } from '../../../ui/EnvLabel';
import { Chip, PageHeader } from '../../../ui/publisher/kit';
import {
  COL_OPTIONS,
  EDIT_LABEL,
  FILTER_EMPTY_ACTION,
  FILTER_EMPTY_BODY,
  FILTER_EMPTY_TITLE,
  FILTER_NAV_LABEL,
  NOT_OFFERED,
  OFFERS_EMPTY_BODY,
  OFFERS_EMPTY_TITLE,
  OFFERS_HEADING,
  OFFERS_LEDE,
  abstractText,
  editLinkText,
  listFactsLine,
  offerStatusText,
  optionPriceText,
} from '../../../lib/offer-copy';
import {
  OFFER_FILTERS,
  filterCounts,
  filterHref,
  filterOffers,
  parseOfferFilter,
  statusTone,
  tabText,
} from '../../../lib/offers-view';
import { CREATE_LINK } from '../../../lib/publisher-e1-copy';
import { OfferCover } from './OfferCover';
import '../pk-offers.css';

export const metadata: Metadata = { title: 'Your offers' };

// PUB-B (S2): the signed-in publisher's own offers, newest version of each. The publisher is the one in
// the session and nowhere else: the engine filters every query by it. The only parameter read is the
// status tab (PUB-UI-OFFERS), which narrows the rows already received; an unknown value shows all.
export default async function PublisherOffers({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await currentActor();
  if (actor?.kind !== 'publisher') redirect('/signin?next=/publisher/offers');
  const view = await (await app()).engine.offers.list(actor);
  if (view === null) redirect('/signin?next=/publisher/offers');
  const active = parseOfferFilter((await searchParams).status);
  const counts = filterCounts(view.offers);
  const shown = filterOffers(view.offers, active);
  const create = (
    <Link className="btn btn-primary" href="/publisher/offers/new">
      {CREATE_LINK}
    </Link>
  );
  return (
    <>
      <PageHeader
        title={OFFERS_HEADING}
        lede={OFFERS_LEDE}
        aside={
          <>
            <EnvLabel environment={view.environment} />
            {create}
          </>
        }
      />
      {view.offers.length === 0 ? (
        <EmptyState title={OFFERS_EMPTY_TITLE} action={create}>
          {OFFERS_EMPTY_BODY}
        </EmptyState>
      ) : (
        <>
          <nav aria-label={FILTER_NAV_LABEL}>
            <ul className="pk-offer-tabs">
              {OFFER_FILTERS.map((f) => (
                <li key={f}>
                  <Link href={filterHref(f)} aria-current={f === active ? 'page' : undefined}>
                    {tabText(f, counts[f])}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {shown.length === 0 ? (
            <EmptyState
              title={FILTER_EMPTY_TITLE}
              action={
                <Link className="btn" href={filterHref('all')}>
                  {FILTER_EMPTY_ACTION}
                </Link>
              }
            >
              {FILTER_EMPTY_BODY}
            </EmptyState>
          ) : (
            <ul className="pk-offers" aria-label={OFFERS_HEADING}>
              {shown.map((o) => (
                <li key={o.offer_id} className="pk-offer" data-testid="offer-row">
                  <OfferCover title={o.article_title} />
                  <div className="pk-offer-body">
                    <div className="pk-offer-top">
                      <h2 className="pk-offer-title">{o.article_title}</h2>
                      <Chip tone={statusTone(o.status)}>{offerStatusText(o.status)}</Chip>
                    </div>
                    <p className="pk-offer-abstract muted" data-testid="offer-row-abstract">
                      {abstractText(o.article_abstract)}
                    </p>
                    {o.options.length === 0 ? (
                      <p className="pk-offer-facts">{NOT_OFFERED}</p>
                    ) : (
                      <ul className="pk-offer-prices" aria-label={COL_OPTIONS}>
                        {o.options.map((p) => (
                          <li key={p.option}>
                            <Chip tone="info">
                              {optionPriceText(p.option, p.price_minor, o.currency)}
                            </Chip>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="pk-offer-facts" data-testid="offer-row-facts">
                      {listFactsLine({
                        language: o.article_language,
                        bytes: o.article_bytes,
                        sha256: o.article_sha256,
                      })}
                    </p>
                    <div className="pk-offer-foot">
                      <Link
                        className="btn"
                        href={`/publisher/offers/${encodeURIComponent(o.offer_id)}`}
                      >
                        <span aria-hidden="true">{EDIT_LABEL}</span>
                        <span className="visually-hidden">{editLinkText(o.article_title)}</span>
                      </Link>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
