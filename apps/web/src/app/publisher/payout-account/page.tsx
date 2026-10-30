import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EmptyState } from '../../../ui/EmptyState';
import { EnvLabel, envText } from '../../../ui/EnvLabel';
import { formatDateTime } from '../../../lib/format';
import {
  HISTORY_EMPTY,
  HISTORY_HEADING,
  LABEL_ACCOUNT,
  LABEL_SETTLEMENT,
  LABEL_VERIFIED,
  LABEL_VERIFIED_BY,
  OWNER_ONLY_NOTE,
  PAYEE_HEADING,
  PAYEE_LEDE,
  accountText,
  historyLine,
  settlementText,
  verifiedAtText,
  verifiedByText,
} from '../../../lib/payee-copy';
import { RequestForm } from './RequestForm';

export const metadata: Metadata = { title: 'Where you get paid' };

// PUB-A2 (S6): the signed-in publisher's payee, last 4 only. The id comes from the session and nowhere
// else: the page reads no parameters, and the engine filters every query by it. The payee cannot be
// changed here; the form only sends a request that an operator checks.
export default async function PayoutAccount() {
  const actor = await currentActor();
  if (actor?.kind !== 'publisher') redirect('/signin?next=/publisher/payout-account');
  const view = await (await app()).engine.payee.view(actor);
  if (view === null) redirect('/signin?next=/publisher/payout-account');
  const stored = { last4: view.last4, verified_at: view.verified_at };
  return (
    <>
      <h1>
        {PAYEE_HEADING} <EnvLabel environment={view.environment} />
      </h1>
      <p className="lede">{PAYEE_LEDE}</p>
      <div className="card">
        <dl>
          <dt>{LABEL_ACCOUNT}</dt>
          <dd data-testid="payee-account">{accountText(view.last4)}</dd>
          <dt>{LABEL_VERIFIED}</dt>
          <dd data-testid="payee-verified">
            {verifiedAtText(view.verified_at === null ? null : formatDateTime(view.verified_at))}
          </dd>
          <dt>{LABEL_VERIFIED_BY}</dt>
          <dd data-testid="payee-verified-by">
            {verifiedByText(view.history.some((h) => h.state === 'verified'))}
          </dd>
          <dt>{LABEL_SETTLEMENT}</dt>
          <dd data-testid="payee-settlement">
            {settlementText(stored, envText(view.environment))}
          </dd>
        </dl>
      </div>
      {view.environment === 'sandbox' ? (
        <p role="status" className="muted" data-testid="payee-owner-only">
          <strong>{OWNER_ONLY_NOTE}</strong>
        </p>
      ) : null}
      <RequestForm />
      <h2>{HISTORY_HEADING}</h2>
      {view.history.length === 0 ? (
        <EmptyState title={HISTORY_EMPTY} />
      ) : (
        <ul data-testid="payee-history">
          {view.history.map((h) => (
            <li key={h.request_id}>
              {historyLine(h)} <span className="muted">{formatDateTime(h.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
