import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EnvLabel } from '../../../ui/EnvLabel';
import { formatDateTime } from '../../../lib/format';
import {
  OPS_COL_AGE,
  OPS_COL_PUBLISHER,
  OPS_COL_REQUESTED,
  OPS_EMPTY,
  OPS_HEADING,
  OPS_LEDE,
  OWNER_ONLY_NOTE,
  ageText,
} from '../../../lib/payee-copy';
import { DecisionForm } from './DecisionForm';

export const metadata: Metadata = { title: 'Payee requests' };

// PUB-A2: the operator's queue of payee change requests. Operator with the second factor only (the
// engine answers an error to any other session). The queue shows the last 4 of the requested id; the
// operator types the whole id again to verify. On the hosted sandbox app the form is not shown.
export default async function PayeeRequests() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator' || !actor.mfa) redirect('/signin?next=/ops/payee-requests');
  const r = await (await app()).engine.payee.openRequests(actor);
  if (!r.ok) redirect('/signin?next=/ops/payee-requests');
  const { requests, environment } = r.value;
  return (
    <>
      <h1>
        {OPS_HEADING} <EnvLabel environment={environment} />
      </h1>
      <p className="lede">{OPS_LEDE}</p>
      {environment === 'sandbox' ? (
        <p role="status" className="muted" data-testid="payee-owner-only">
          <strong>{OWNER_ONLY_NOTE}</strong>
        </p>
      ) : null}
      {requests.length === 0 ? (
        <p className="muted" data-testid="payee-queue-empty">
          {OPS_EMPTY}
        </p>
      ) : (
        <div className="table-scroll" role="region" aria-label={OPS_HEADING} tabIndex={0}>
          <table>
            <caption className="visually-hidden">{OPS_HEADING}</caption>
            <thead>
              <tr>
                <th scope="col">{OPS_COL_PUBLISHER}</th>
                <th scope="col">{OPS_COL_REQUESTED}</th>
                <th scope="col">{OPS_COL_AGE}</th>
                <th scope="col">
                  <span className="visually-hidden">Decision</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {requests.map((q) => (
                <tr key={q.request_id} data-testid="payee-queue-row">
                  <td>{q.publisher_name}</td>
                  <td>Ending {q.requested_last4}</td>
                  <td title={formatDateTime(q.created_at)}>{ageText(q.age_ms)}</td>
                  <td>
                    <DecisionForm
                      requestId={q.request_id}
                      last4={q.requested_last4}
                      canVerify={environment !== 'sandbox'}
                    />
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
