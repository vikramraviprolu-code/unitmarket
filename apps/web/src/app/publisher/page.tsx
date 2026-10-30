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
import {
  SINCE_FIRST,
  SINCE_HEADING,
  SINCE_NONE,
  sinceFromText,
  sinceLines,
} from '../../lib/publisher-e1-copy';
import { formatDateTime } from '../../lib/format';

export const metadata: Metadata = { title: 'Publisher' };

// PUB-A1: the read only home of the signed-in publisher. The id comes from the session and nowhere
// else: the page reads no parameters, and the engine filters every query by it.
export default async function PublisherHome() {
  const actor = await currentActor();
  if (actor?.kind !== 'publisher') redirect('/signin?next=/publisher');
  const home = await (await app()).engine.publisherHome(actor);
  if (home === null) redirect('/signin?next=/publisher');
  // PUB-E1: what changed since the last visit. Reading it records this visit in the publisher's own row.
  const since = await (await app()).engine.publisherSince(actor);
  const sinceList = since?.counts == null ? [] : sinceLines(since.counts);
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
        </dl>
      </div>
      <section aria-labelledby="since-heading" data-testid="publisher-since">
        <h2 id="since-heading">{SINCE_HEADING}</h2>
        {since === null || since.first_visit ? (
          <p>{SINCE_FIRST}</p>
        ) : sinceList.length === 0 ? (
          <p>{SINCE_NONE}</p>
        ) : (
          <>
            <ul>
              {sinceList.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
        {since?.since == null ? null : (
          <p className="muted">{sinceFromText(formatDateTime(since.since))}</p>
        )}
      </section>
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
