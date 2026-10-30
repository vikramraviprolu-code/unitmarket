import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EnvLabel, envText } from '../../../ui/EnvLabel';
import { StatusBanner } from '../../../ui/StatusBanner';
import { formatMinor } from '../../../lib/format';
import {
  APPLIED_HINT,
  COL_CAPTURED,
  COL_CURRENCY,
  COL_HELD,
  COL_NOT_REFUNDED,
  COL_REFUNDS_OPEN,
  LABEL_MONEY,
  LABEL_OFFERS,
  LABEL_PAYEE,
  LABEL_SETTLEMENT,
  LABEL_STATUS,
  NONE_CELL,
  NO_PAYMENTS,
  OPS_LINK_PAYEE_REQUESTS,
  PUBLISHERS_MFA_BODY,
  PUBLISHERS_MFA_HEADING,
  PUBLISHERS_MFA_LINK,
  PUBLISHERS_BACK_LINK,
  PUBLISHERS_EMPTY,
  PUBLISHERS_HEADING,
  PUBLISHERS_LEDE,
  REACTIVATE_HINT,
  SUSPEND_HINT,
  countAmountText,
  offersText,
  payeeText,
  statusText,
  unitsText,
} from '../../../lib/ops-publishers-copy';
import {
  ADD_HEADING,
  APPLICANTS_EMPTY,
  APPLICANTS_HEADING,
  APPLICANTS_LEDE,
  APPLICANTS_NO_LOGIN,
  APPROVE_HINT,
  REJECT_HINT,
  applicantLine,
  applicantStateText,
  rejectedReasonText,
} from '../../../lib/ops-applicants-copy';
import { PUBLISHER_TERMS_VERSION } from '../../../lib/legal-copy';
import {
  LINK_PUBLISHER_TERMS,
  NOT_ACCEPTED_TEXT,
  acceptedByText,
  agreementChangedText,
  agreementText,
} from '../../../lib/agreement-copy';
import { StatusForm } from './StatusForm';
import { AddApplicantForm, DecideApplicantForm } from './ApplicantForms';

export const metadata: Metadata = { title: 'Publishers' };

// AGREE-1: the stored record, in words, with the flag when its version is not the current one.
function PublisherTermsLine({
  agreement,
}: {
  agreement: { accepted_at: string; terms_version: string; accepted_by_label: string } | null;
}) {
  if (agreement === null)
    return (
      <p className="muted" data-testid="publisher-agreement">
        {NOT_ACCEPTED_TEXT} <Link href="/legal/publisher-terms">{LINK_PUBLISHER_TERMS}</Link>
      </p>
    );
  return (
    <p className="muted" data-testid="publisher-agreement">
      {agreementText(agreement)} {acceptedByText(agreement.accepted_by_label)}{' '}
      {agreement.terms_version !== PUBLISHER_TERMS_VERSION ? (
        <strong data-testid="publisher-agreement-changed">
          {agreementChangedText(PUBLISHER_TERMS_VERSION)}
        </strong>
      ) : null}{' '}
      <Link href="/legal/publisher-terms">{LINK_PUBLISHER_TERMS}</Link>
    </p>
  );
}

function MfaNeeded() {
  return (
    <>
      <h1>{PUBLISHERS_HEADING}</h1>
      <StatusBanner tone="warn" title={PUBLISHERS_MFA_HEADING}>
        <span data-testid="publishers-mfa-needed">{PUBLISHERS_MFA_BODY}</span>{' '}
        <Link href="/signin?next=/ops/publishers">{PUBLISHERS_MFA_LINK}</Link>
      </StatusBanner>
    </>
  );
}

// PUB-D (S7): the operator's table of publishers. Operator with the second factor only; the engine
// answers an error to any other session. It shows counts and sums of stored rows and the last 4 of the
// payee account; it names no buyer. The suspend form posts to the route, which checks everything again.
export default async function OpsPublishers() {
  const actor = await currentActor();
  // An operator without the authenticator code is told why, not sent to the sign in page unexplained.
  if (actor?.kind === 'operator' && !actor.mfa) return <MfaNeeded />;
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/publishers');
  const r = await (await app()).engine.opsPublishers.list(actor);
  if (!r.ok) {
    if (r.error.code === 'mfa_required') return <MfaNeeded />;
    redirect('/signin?next=/ops/publishers');
  }
  const { environment } = r.value;
  const publishers = r.value.publishers.filter((p) => p.status !== 'applied');
  const ap = await (await app()).engine.opsApplicants.list(actor);
  if (!ap.ok) {
    if (ap.error.code === 'mfa_required') return <MfaNeeded />;
    redirect('/signin?next=/ops/publishers');
  }
  const applicants = ap.value.applicants;
  // AGREE-1: the seeded, read only publisher terms record, by publisher. An applicant has none.
  const ag = await (await app()).engine.opsAgreements.list(actor);
  if (!ag.ok) {
    if (ag.error.code === 'mfa_required') return <MfaNeeded />;
    redirect('/signin?next=/ops/publishers');
  }
  const agreementOf = new Map(ag.value.agreements.map((a) => [a.publisher_id, a]));
  return (
    <>
      <h1>
        {PUBLISHERS_HEADING} <EnvLabel environment={environment} />
      </h1>
      <p className="lede">{PUBLISHERS_LEDE}</p>
      <p>
        <Link href="/ops/payee-requests">{OPS_LINK_PAYEE_REQUESTS}</Link>
      </p>
      <section className="card" aria-labelledby="applicants-heading" data-testid="applicants">
        <h2 id="applicants-heading">{APPLICANTS_HEADING}</h2>
        <p>{APPLICANTS_LEDE}</p>
        <p className="muted" data-testid="applicants-no-login">
          {APPLICANTS_NO_LOGIN}
        </p>
        {applicants.length === 0 ? (
          <p className="muted" data-testid="applicants-empty">
            {APPLICANTS_EMPTY}
          </p>
        ) : (
          applicants.map((a) => (
            <section
              key={a.publisher_id}
              className="card"
              aria-labelledby={`applicant-${a.publisher_id}`}
              data-testid="applicant-row"
            >
              <h3 id={`applicant-${a.publisher_id}`}>{a.display_name}</h3>
              <p className="muted">{applicantLine(a)}</p>
              <p className="muted" data-testid="applicant-agreement">
                {NOT_ACCEPTED_TEXT}
              </p>
              <p data-testid="applicant-state">
                {a.state === 'rejected' && a.decision_reason !== null
                  ? rejectedReasonText(a.decision_reason)
                  : applicantStateText(a.state)}
              </p>
              {a.state === 'pending' ? (
                <>
                  <p className="muted">{APPROVE_HINT}</p>
                  <p className="muted">{REJECT_HINT}</p>
                  <DecideApplicantForm publisherId={a.publisher_id} name={a.display_name} />
                </>
              ) : null}
            </section>
          ))
        )}
        <h3>{ADD_HEADING}</h3>
        <AddApplicantForm />
      </section>
      {publishers.length === 0 ? (
        <p className="muted" data-testid="publishers-empty">
          {PUBLISHERS_EMPTY}
        </p>
      ) : (
        publishers.map((p) => (
          <section
            key={p.publisher_id}
            className="card"
            aria-labelledby={`pub-${p.publisher_id}`}
            data-testid="publisher-row"
          >
            <h2 id={`pub-${p.publisher_id}`}>{p.display_name}</h2>
            <dl>
              <dt>{LABEL_STATUS}</dt>
              <dd data-testid="publisher-row-status">{statusText(p.status)}</dd>
              <dt>{LABEL_PAYEE}</dt>
              <dd>
                {payeeText({
                  last4: p.payee_last4,
                  verified: p.payee_verified_at !== null,
                  shared: p.payee_shared,
                })}
              </dd>
              <dt>{LABEL_SETTLEMENT}</dt>
              <dd data-testid="publisher-row-settlement">{p.settlement.sentence}</dd>
              <dt>{LABEL_OFFERS}</dt>
              <dd>{offersText(p.offers_live)}</dd>
            </dl>
            <PublisherTermsLine agreement={agreementOf.get(p.publisher_id) ?? null} />
            <h3>{LABEL_MONEY}</h3>
            {p.by_currency.length === 0 ? (
              <p className="muted">{NO_PAYMENTS}</p>
            ) : (
              <div
                className="table-scroll"
                role="region"
                aria-label={`${LABEL_MONEY}: ${p.display_name}`}
                tabIndex={0}
              >
                <table>
                  <caption className="visually-hidden">
                    {LABEL_MONEY}: {p.display_name}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{COL_CURRENCY}</th>
                      <th scope="col">{COL_CAPTURED}</th>
                      <th scope="col">{COL_NOT_REFUNDED}</th>
                      <th scope="col">{COL_REFUNDS_OPEN}</th>
                      <th scope="col">{COL_HELD}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.by_currency.map((b) => (
                      <tr key={`${b.currency}-${b.environment}`} data-testid="exposure-row">
                        <th scope="row">
                          {b.currency} ({envText(b.environment)})
                        </th>
                        <td>{unitsText(b.units_captured)}</td>
                        <td>{formatMinor(b.captured_not_refunded_minor, b.currency)}</td>
                        <td>
                          {b.refunds_open_count === 0
                            ? NONE_CELL
                            : countAmountText(
                                b.refunds_open_count,
                                formatMinor(b.refunds_open_minor, b.currency),
                              )}
                        </td>
                        <td>
                          {b.held_count === 0
                            ? NONE_CELL
                            : countAmountText(b.held_count, formatMinor(b.held_minor, b.currency))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {p.status === 'applied' ? (
              <p className="muted">{APPLIED_HINT}</p>
            ) : (
              <>
                <p className="muted">{p.status === 'suspended' ? REACTIVATE_HINT : SUSPEND_HINT}</p>
                <StatusForm
                  publisherId={p.publisher_id}
                  name={p.display_name}
                  suspended={p.status === 'suspended'}
                />
              </>
            )}
          </section>
        ))
      )}
      <p>
        <Link href="/ops">{PUBLISHERS_BACK_LINK}</Link>
      </p>
    </>
  );
}
