import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { readOpsPayeeQueue } from '../../../composition/ops-sellers';
import { currentActor } from '../../../server/session';
import { EnvLabel } from '../../../ui/EnvLabel';
import { Chip, PageHeader, StatTile } from '../../../ui/publisher/kit';
import { StatusBanner } from '../../../ui/StatusBanner';
import { SectionNav } from '../../../ui/SectionNav';
import { OPS_PAYEE_SECTIONS, maskedMerchant } from '../../../lib/ops-copy';
import { formatDateTime } from '../../../lib/format';
import {
  OPS_COL_AGE,
  OPS_COL_REQUESTED,
  OPS_EMPTY,
  OPS_HEADING,
  OPS_LEDE,
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
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/payee-requests');
  // INT-OPS-A / OPS-A.7: an operator without the authenticator code reads the queue; the buttons are off.
  const r = await readOpsPayeeQueue(actor);
  if (r === null) redirect('/signin?next=/ops/payee-requests');
  const { requests, environment, mfa } = r;
  const oldest = oldestAgeMs(requests);
  return (
    <>
      <PageHeader
        title={OPS_HEADING}
        lede={OPS_LEDE}
        aside={<EnvLabel environment={environment} />}
      />
      <SectionNav label="Sections of this page" items={OPS_PAYEE_SECTIONS} />
      {environment === 'sandbox' ? (
        <StatusBanner tone="info">
          <span data-testid="payee-owner-only">
            <strong>{OWNER_ONLY_NOTE}</strong>
          </span>
        </StatusBanner>
      ) : null}
      <div className="pk-tiles" id="ops-payee-summary">
        <StatTile label={TILE_OPEN_REQUESTS} value={requests.length} />
        <StatTile label={TILE_OLDEST} value={oldest === null ? TILE_NONE : ageText(oldest)} />
      </div>
      {requests.length === 0 ? (
        <p className="muted pk-section" id="ops-payee-queue" data-testid="payee-queue-empty">
          {OPS_EMPTY}
        </p>
      ) : (
        <div className="pk-section pk-stack" id="ops-payee-queue">
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
                <dd className="mono">{maskedMerchant(q.requested_last4)}</dd>
                <dt>{OPS_COL_AGE}</dt>
                <dd title={formatDateTime(q.created_at)}>{ageText(q.age_ms)}</dd>
              </dl>
              <DecisionForm
                requestId={q.request_id}
                last4={q.requested_last4}
                canVerify={environment !== 'sandbox'}
                hasCode={mfa}
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
