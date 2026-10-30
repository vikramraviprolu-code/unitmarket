import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EmptyState } from '../../../ui/EmptyState';
import { EnvLabel } from '../../../ui/EnvLabel';
import {
  COL_ACTION,
  COL_ARTICLE,
  COL_OPTIONS,
  COL_STATUS,
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

export const metadata: Metadata = { title: 'Your offers' };

// PUB-B (S2): the signed-in publisher's own offers, newest version of each. The publisher is the one in
// the session and nowhere else: the page reads no parameters, and the engine filters every query by it.
export default async function PublisherOffers() {
  const actor = await currentActor();
  if (actor?.kind !== 'publisher') redirect('/signin?next=/publisher/offers');
  const view = await (await app()).engine.offers.list(actor);
  if (view === null) redirect('/signin?next=/publisher/offers');
  return (
    <>
      <h1>
        {OFFERS_HEADING} <EnvLabel environment={view.environment} />
      </h1>
      <p className="lede">{OFFERS_LEDE}</p>
      {view.offers.length === 0 ? (
        <EmptyState title={OFFERS_EMPTY_TITLE}>{OFFERS_EMPTY_BODY}</EmptyState>
      ) : (
        <div className="table-scroll" role="region" aria-label={OFFERS_HEADING} tabIndex={0}>
          <table>
            <caption className="visually-hidden">{OFFERS_HEADING}</caption>
            <thead>
              <tr>
                <th scope="col">{COL_ARTICLE}</th>
                <th scope="col">{COL_OPTIONS}</th>
                <th scope="col">{COL_STATUS}</th>
                <th scope="col">
                  <span className="visually-hidden">{COL_ACTION}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {view.offers.map((o) => (
                <tr key={o.offer_id} data-testid="offer-row">
                  <td>
                    {o.article_title}
                    <p className="muted" data-testid="offer-row-abstract">
                      {abstractText(o.article_abstract)}
                    </p>
                    <p className="muted" data-testid="offer-row-facts">
                      {listFactsLine({
                        language: o.article_language,
                        bytes: o.article_bytes,
                        sha256: o.article_sha256,
                      })}
                    </p>
                  </td>
                  <td>
                    {o.options.length === 0 ? (
                      NOT_OFFERED
                    ) : (
                      <ul className="plain-list">
                        {o.options.map((p) => (
                          <li key={p.option}>
                            {optionPriceText(p.option, p.price_minor, o.currency)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>{offerStatusText(o.status)}</td>
                  <td>
                    <Link href={`/publisher/offers/${encodeURIComponent(o.offer_id)}`}>
                      {editLinkText(o.article_title)}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
