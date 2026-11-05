import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../../server/access';
import { currentActor } from '../../../../server/session';
import { EnvLabel } from '../../../../ui/EnvLabel';
import { Chip, PageHeader, Section } from '../../../../ui/publisher/kit';
import { SectionNav } from '../../../../ui/SectionNav';
import { StatusBanner } from '../../../../ui/StatusBanner';
import { formatDateTime, formatMinor, optionLabel } from '../../../../lib/format';
import {
  ARTICLE_FACTS_HEADING,
  ARTICLE_FACTS_NOTE,
  BACK_TO_OFFERS,
  DRAFT_NOTICE,
  FREEZE_NOTE,
  HISTORY_HEADING,
  LABEL_ABSTRACT,
  LABEL_ARTICLE,
  LABEL_CURRENCY,
  LABEL_FINGERPRINT,
  LABEL_LANGUAGE,
  LABEL_LICENCE,
  LABEL_SIZE,
  LABEL_STATUS,
  LABEL_TERMS,
  LABEL_VERSION,
  LABEL_WINDOW,
  OFFER_LEDE,
  WINDOW_VALUE,
  WITHDRAWN_NOTICE,
  abstractText,
  fingerprintText,
  historyLine,
  languageText,
  licenceText,
  offerStatusText,
  offeredLabel,
  optionPriceText,
  priceHint,
  priceInputValue,
  priceLabel,
  sizeText,
} from '../../../../lib/offer-copy';
import {
  BUYER_SEES_HEADING,
  BUYER_SEES_NOTE,
  BUYER_SEES_NOTE_READONLY,
  BUYER_SEES_OFF,
  HELP_LICENCE,
  OFFER_READONLY_LEDE,
  SECTION_LICENCE,
  SECTION_WHAT,
  offerStatusTone,
} from '../../../../lib/publisher-forms-copy';
import { OfferForm, WithdrawForm } from './OfferForm';
import '../../pk-forms.css';
import { readSellerOffer } from '../../../../composition/seller';
import { SEVERAL_ARTICLES_NOTE } from '../../../../lib/seller-offer-view';

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
  // INT-SEL (SEL.6): the sales of this offer, once each across its versions, with its share of each sale's money.
  const sold = await readSellerOffer(actor, id);
  const sales = sold === null ? [] : sold.sales;
  const live = o.status === 'authorised';
  const rows = OPTIONS.map((option) => {
    const current = o.options.find((p) => p.option === option);
    return {
      option,
      offeredLabel: offeredLabel(option),
      priceLabel: priceLabel(option, o.currency),
      optionName: optionLabel(option),
      offered: current !== undefined,
      price: current === undefined ? '' : priceInputValue(current.price_minor),
    };
  });
  const licence = (
    <Section title={SECTION_LICENCE} id="offer-licence-section">
      <div className="pk-panel">
        <dl className="pk-facts">
          <dt>{LABEL_LICENCE}</dt>
          <dd data-testid="offer-licence">{licenceText(o.rights)}</dd>
          <dt>{LABEL_WINDOW}</dt>
          <dd data-testid="offer-window">{WINDOW_VALUE}</dd>
          <dt>{LABEL_TERMS}</dt>
          <dd data-testid="offer-terms">{o.terms_version}</dd>
        </dl>
        <p className="pk-help">{HELP_LICENCE}</p>
      </div>
    </Section>
  );
  return (
    <>
      <p className="pk-back">
        <Link href="/publisher/offers">{BACK_TO_OFFERS}</Link>
      </p>
      <PageHeader
        title={o.article_title}
        lede={live ? OFFER_LEDE : OFFER_READONLY_LEDE}
        aside={<EnvLabel environment={o.environment} />}
      />
      {live ? null : (
        <StatusBanner tone="warn">
          <span data-testid="offer-withdrawn-notice">
            {o.status === 'draft' ? DRAFT_NOTICE : WITHDRAWN_NOTICE}
          </span>
        </StatusBanner>
      )}
      <p className="pk-chips">
        <Chip tone={offerStatusTone(o.status)}>{offerStatusText(o.status)}</Chip>
        <Chip tone="neutral">{`${LABEL_VERSION} ${o.version}`}</Chip>
      </p>
      <SectionNav
        label="On this page"
        items={[
          { id: 'offer-buyer', label: 'What buyers see' },
          { id: 'offer-what', label: 'The article' },
          { id: 'offer-licence-section', label: 'Licence' },
          { id: 'offer-history-section', label: 'History' },
        ]}
      />
      <Section title={BUYER_SEES_HEADING} id="offer-buyer">
        <div className="pk-panel">
          {live ? (
            <ul className="pk-buyer-list">
              {o.options.map((p) => (
                <li key={p.option}>{optionPriceText(p.option, p.price_minor, o.currency)}</li>
              ))}
            </ul>
          ) : (
            <p>{BUYER_SEES_OFF}</p>
          )}
          <p className="muted" data-testid="offer-freeze-note">
            {FREEZE_NOTE}
          </p>
          <p className="pk-help">{live ? BUYER_SEES_NOTE : BUYER_SEES_NOTE_READONLY}</p>
        </div>
      </Section>
      <Section title={SECTION_WHAT} id="offer-what">
        <div className="pk-panel">
          <dl className="pk-facts">
            <dt>{LABEL_ARTICLE}</dt>
            <dd data-testid="offer-article">{o.article_title}</dd>
            <dt>{LABEL_STATUS}</dt>
            <dd data-testid="offer-status">{offerStatusText(o.status)}</dd>
            <dt>{LABEL_VERSION}</dt>
            <dd data-testid="offer-version">{o.version}</dd>
            <dt>{LABEL_CURRENCY}</dt>
            <dd data-testid="offer-currency">{o.currency}</dd>
          </dl>
          <h3>{ARTICLE_FACTS_HEADING}</h3>
          <dl className="pk-facts">
            <dt>{LABEL_ABSTRACT}</dt>
            <dd data-testid="offer-abstract">{abstractText(o.article_abstract)}</dd>
            <dt>{LABEL_LANGUAGE}</dt>
            <dd data-testid="offer-language">{languageText(o.article_language)}</dd>
            <dt>{LABEL_SIZE}</dt>
            <dd data-testid="offer-size">{sizeText(o.article_bytes)}</dd>
            <dt>{LABEL_FINGERPRINT}</dt>
            <dd data-testid="offer-fingerprint">{fingerprintText(o.article_sha256)}</dd>
          </dl>
          <p className="pk-help" data-testid="offer-facts-note">
            {ARTICLE_FACTS_NOTE}
          </p>
        </div>
      </Section>
      {live ? (
        <>
          <OfferForm
            offerId={o.offer_id}
            version={o.version}
            capMinor={o.offer_max_minor}
            hint={priceHint(formatMinor(1, o.currency), formatMinor(o.offer_max_minor, o.currency))}
            prefix={o.currency}
            rows={rows}
          >
            {licence}
          </OfferForm>
          <WithdrawForm offerId={o.offer_id} version={o.version} />
        </>
      ) : (
        <>{licence}</>
      )}
      <Section title={HISTORY_HEADING} id="offer-history-section">
        <div className="pk-panel">
          <ul className="pk-history" data-testid="offer-history">
            {o.history.map((h, i) => (
              <li key={h.version}>
                {historyLine({
                  version: h.version,
                  status: h.status,
                  superseded: i > 0,
                  when: formatDateTime(h.created_at),
                  prices: h.options.map(
                    (p) => `${optionLabel(p.option)} ${formatMinor(p.price_minor, o.currency)}`,
                  ),
                })}
              </li>
            ))}
          </ul>
        </div>
      </Section>
      <section
        aria-labelledby="offer-sales-h"
        className="pk-section"
        id="offer-sales"
        data-testid="offer-sales"
      >
        <h2 id="offer-sales-h">Sales of this offer</h2>
        {sales.length === 0 ? (
          <p className="muted">No sales of this offer yet.</p>
        ) : (
          <>
            <table className="pk-table">
              <caption className="visually-hidden">Sales of this offer</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Sale</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="pk-num">
                    Net share
                  </th>
                </tr>
              </thead>
              <tbody>
                {sales.map((x) => (
                  <tr key={x.unit_id}>
                    <td>{formatDateTime(x.created_at)}</td>
                    <td className="mono">
                      <Link href={`/publisher/sales/${encodeURIComponent(x.unit_id)}`}>
                        {x.order_ref6}
                      </Link>
                    </td>
                    <td>{x.status}</td>
                    <td className="pk-num">{formatMinor(x.net_minor, x.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">{SEVERAL_ARTICLES_NOTE}</p>
          </>
        )}
      </section>
    </>
  );
}
