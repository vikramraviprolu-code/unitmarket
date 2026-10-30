import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { app } from '../../server/access';
import { currentActor } from '../../server/session';
import { EmptyState } from '../../ui/EmptyState';
import {
  APPLIED_NOTICE,
  LABEL_NAME,
  LINK_OFFERS,
  LINK_PAYOUT_ACCOUNT,
  LINK_SALES,
  LINK_STATEMENT,
  LABEL_OFFERS,
  LABEL_PAYEE,
  LABEL_SETTLEMENT,
  LABEL_STATUS,
  NO_OFFERS_BODY,
  NO_OFFERS_TITLE,
  PUBLISHER_HEADING,
  PUBLISHER_LEDE,
  SUSPENDED_NOTICE,
  offersLiveText,
  payeeText,
  publisherStatusText,
} from '../../lib/publisher-copy';

export const metadata: Metadata = { title: 'Publisher' };

// PUB-A1: the read only home of the signed-in publisher. The id comes from the session and nowhere
// else: the page reads no parameters, and the engine filters every query by it.
export default async function PublisherHome() {
  const actor = await currentActor();
  if (actor?.kind !== 'publisher') redirect('/signin?next=/publisher');
  const home = await (await app()).engine.publisherHome(actor);
  if (home === null) redirect('/signin?next=/publisher');
  return (
    <>
      <h1>{PUBLISHER_HEADING}</h1>
      <p className="lede">{PUBLISHER_LEDE}</p>
      {home.status === 'suspended' ? (
        <p role="status" className="muted" data-testid="publisher-notice">
          <strong>{SUSPENDED_NOTICE}</strong>
        </p>
      ) : null}
      {home.status === 'applied' ? (
        <p role="status" className="muted" data-testid="publisher-notice">
          <strong>{APPLIED_NOTICE}</strong>
        </p>
      ) : null}
      <div className="card">
        <dl>
          <dt>{LABEL_NAME}</dt>
          <dd data-testid="publisher-name">{home.display_name}</dd>
          <dt>{LABEL_STATUS}</dt>
          <dd data-testid="publisher-status">{publisherStatusText(home.status)}</dd>
          <dt>{LABEL_OFFERS}</dt>
          <dd data-testid="publisher-offers">{offersLiveText(home.offers_live)}</dd>
          <dt>{LABEL_PAYEE}</dt>
          <dd data-testid="publisher-payee">{payeeText(home.payee)}</dd>
          <dt>{LABEL_SETTLEMENT}</dt>
          <dd data-testid="publisher-settlement">{home.settlement.sentence}</dd>
        </dl>
      </div>
      <ul data-testid="publisher-links">
        <li>
          <Link href="/publisher/offers">{LINK_OFFERS}</Link>
        </li>
        <li>
          <Link href="/publisher/sales">{LINK_SALES}</Link>
        </li>
        <li>
          <Link href="/publisher/statement">{LINK_STATEMENT}</Link>
        </li>
        <li>
          <Link href="/publisher/payout-account">{LINK_PAYOUT_ACCOUNT}</Link>
        </li>
      </ul>
      {home.offers_live === 0 ? (
        <EmptyState title={NO_OFFERS_TITLE}>{NO_OFFERS_BODY}</EmptyState>
      ) : null}
    </>
  );
}
