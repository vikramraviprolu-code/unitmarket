import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EnvLabel } from '../../../ui/EnvLabel';
import { Chip, PageHeader, StatTile } from '../../../ui/publisher/kit';
import { StatusBanner } from '../../../ui/StatusBanner';
import { formatDateTime } from '../../../lib/format';
import {
  OPS_COL_AGE,
  OPS_COL_REQUESTED,
  OPS_EMPTY,
  OPS_HEADING,
  OPS_LEDE,
  OPS_MFA_BODY,
  OPS_MFA_HEADING,
  OPS_MFA_LINK,
  OWNER_ONLY_NOTE,
  ageText,
} from '../../../lib/payee-copy';
import {
  REQUEST_STATE_OPEN,
  TILE_NONE,
  TILE_OLDEST,
  TILE_OPEN_REQUESTS,
  oldestAgeMs,
} from '../../../lib/ops-publishers-view';
import { PUBLISHERS_BACK_LINK } from '../../../lib/ops-publishers-copy';
import { DecisionForm } from './DecisionForm';

export const metadata: Metadata = { title: 'Payee requests' };

// PUB-A2: the operator's queue of payee change requests. Operator with the second factor only (the
// engine answers an error to any other session). The queue shows the last 4 of the requested id; the
// operator types the whole id again to verify. On the hosted sandbox app the form is not shown.
export default async function PayeeRequests() {
  const actor = await currentActor();
  // GATE35 D4b: an operator without the authenticator code is told why, not sent away silently.
  if (actor?.kind === 'operator' && !actor.mfa)
    return (
      <>
        <h1>{OPS_HEADING}</h1>
        <StatusBanner tone="warn" title={OPS_MFA_HEADING}>
          <span data-testid="payee-mfa-needed">{OPS_MFA_BODY}</span>{' '}
          <Link href="/signin?next=/ops/payee-requests">{OPS_MFA_LINK}</Link>
        </StatusBanner>
      </>
    );
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/payee-requests');
  const r = await (await app()).engine.payee.openRequests(actor);
  if (!r.ok) redirect('/signin?next=/ops/payee-requests');
  const { requests, environment } = r.value;
  const oldest = oldestAgeMs(requests);
  return (
    <>
      <PageHeader
        title={OPS_HEADING}
        lede={OPS_LEDE}
        aside={<EnvLabel environment={environment} />}
      />
      {environment === 'sandbox' ? (
        <StatusBanner tone="info">
          <span data-testid="payee-owner-only">
            <strong>{OWNER_ONLY_NOTE}</strong>
          </span>
        </StatusBanner>
      ) : null}
      <div className="pk-tiles">
        <StatTile label={TILE_OPEN_REQUESTS} value={requests.length} />
        <StatTile label={TILE_OLDEST} value={oldest === null ? TILE_NONE : ageText(oldest)} />
      </div>
      {requests.length === 0 ? (
        <p className="muted pk-section" data-testid="payee-queue-empty">
          {OPS_EMPTY}
        </p>
      ) : (
        <div className="pk-section pk-stack">
          {requests.map((q) => (
            <article
              key={q.request_id}
              className="pk-panel"
              aria-labelledby={`req-${q.request_id}`}
              data-testid="payee-queue-row"
            >
              <div className="pk-item-head">
                <h2 id={`req-${q.request_id}`}>{q.publisher_name}</h2>
                <div className="pk-chips">
                  <Chip tone="info">{REQUEST_STATE_OPEN}</Chip>
                </div>
              </div>
              <dl className="pk-facts">
                <dt>{OPS_COL_REQUESTED}</dt>
                <dd>Ending {q.requested_last4}</dd>
                <dt>{OPS_COL_AGE}</dt>
                <dd title={formatDateTime(q.created_at)}>{ageText(q.age_ms)}</dd>
              </dl>
              <DecisionForm
                requestId={q.request_id}
                last4={q.requested_last4}
                canVerify={environment !== 'sandbox'}
              />
            </article>
          ))}
        </div>
      )}
      <p className="pk-links">
        <Link href="/ops">{PUBLISHERS_BACK_LINK}</Link>
      </p>
    </>
  );
}
