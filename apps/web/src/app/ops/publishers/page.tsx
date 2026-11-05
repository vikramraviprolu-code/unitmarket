import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { readOpsPublishers } from '../../../composition/ops-sellers';
import { currentActor } from '../../../server/session';
import { EnvLabel, envText } from '../../../ui/EnvLabel';
import { Chip, PageHeader, StatTile } from '../../../ui/publisher/kit';
import { SectionNav } from '../../../ui/SectionNav';
import { OPS_PUBLISHERS_SECTIONS, maskedMerchant } from '../../../lib/ops-copy';
import { formatMinor } from '../../../lib/format';
import { COL_AWAITING } from '../../../lib/pending-copy';
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
  NONE_CELL,
  NO_PAYMENTS,
  OPS_LINK_PAYEE_REQUESTS,
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
} from '../../../lib/ops-applicants-copy';
import { OPS_NOTE_LABEL, OPS_SOURCE_OPERATOR, OPS_SOURCE_PUBLIC } from '../../../lib/apply-copy';
import { PUBLISHER_TERMS_VERSION } from '../../../lib/legal-copy';
import {
  LINK_PUBLISHER_TERMS,
  NOT_ACCEPTED_TEXT,
  acceptedByText,
  agreementChangedText,
  agreementText,
} from '../../../lib/agreement-copy';
import {
  STATUS_DETAILS_SUMMARY,
  TILE_ACTIVE,
  TILE_APPLICANTS,
  TILE_OFFERS,
  TILE_SUSPENDED,
  agreementChip,
  applicantStateChip,
  payeeChip,
  publisherStatusTone,
  publisherTiles,
  reasonGivenText,
} from '../../../lib/ops-publishers-view';
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
      <p className="pk-note" data-testid="publisher-agreement">
        {NOT_ACCEPTED_TEXT} <Link href="/legal/publisher-terms">{LINK_PUBLISHER_TERMS}</Link>
      </p>
    );
  return (
    <p className="pk-note" data-testid="publisher-agreement">
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

// PUB-D (S7): the operator's view of the publishers. Operator with the second factor only; the engine
// answers an error to any other session. It shows counts and sums of stored rows and the last 4 of the
// payee account; it names no buyer. The suspend form posts to the route, which checks everything again.
export default async function OpsPublishers() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/publishers');
  // INT-OPS-A / OPS-A.7: an operator without the authenticator code reads the queue; the buttons are off.
  const read = await readOpsPublishers(actor);
  if (read === null) redirect('/signin?next=/ops/publishers');
  const { environment, awaiting, applicants, mfa } = read;
  const publishers = read.publishers.filter((p) => p.status !== 'applied');
  // AGREE-1: the seeded, read only publisher terms record, by publisher. An applicant has none.
  const agreementOf = new Map(read.agreements.map((a) => [a.publisher_id, a]));
  const tiles = publisherTiles(publishers, applicants);
  return (
    <>
      <PageHeader
        title={PUBLISHERS_HEADING}
        lede={PUBLISHERS_LEDE}
        aside={
          <>
            <EnvLabel environment={environment} />
            <Link className="btn" href="/ops/payee-requests">
              {OPS_LINK_PAYEE_REQUESTS}
            </Link>
          </>
        }
      />
      <SectionNav label="Sections of this page" items={OPS_PUBLISHERS_SECTIONS} />
      <div className="pk-tiles" id="ops-pub-summary" data-testid="publisher-tiles">
        <StatTile label={TILE_ACTIVE} value={tiles.active} />
        <StatTile label={TILE_APPLICANTS} value={tiles.applicantsWaiting} />
        <StatTile label={TILE_SUSPENDED} value={tiles.suspended} />
        <StatTile label={TILE_OFFERS} value={tiles.offersOnSale} />
      </div>
      <section
        className="pk-section"
        id="ops-pub-applicants"
        aria-labelledby="applicants-heading"
        data-testid="applicants"
      >
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
          <div className="pk-stack">
            {applicants.map((a) => {
              const chip = applicantStateChip(a.state);
              return (
                <section
                  key={a.publisher_id}
                  className="pk-panel"
                  aria-labelledby={`applicant-${a.publisher_id}`}
                  data-testid="applicant-row"
                >
                  <div className="pk-item-head">
                    <h3 id={`applicant-${a.publisher_id}`}>{a.display_name}</h3>
                  </div>
                  <p className="muted">{applicantLine(a)}</p>
                  {a.source !== null ? (
                    <p className="muted" data-testid="applicant-source">
                      {a.source === 'public' ? OPS_SOURCE_PUBLIC : OPS_SOURCE_OPERATOR}
                    </p>
                  ) : null}
                  {a.note !== null ? (
                    <p data-testid="applicant-note">
                      {OPS_NOTE_LABEL}: {a.note}
                    </p>
                  ) : null}
                  <p className="muted" data-testid="applicant-agreement">
                    {NOT_ACCEPTED_TEXT}
                  </p>
                  <p className="pk-state" data-testid="applicant-state">
                    <Chip tone={chip.tone}>{chip.text}</Chip>
                    {a.state === 'rejected' && a.decision_reason !== null ? (
                      <span>{reasonGivenText(a.decision_reason)}</span>
                    ) : null}
                  </p>
                  {a.state === 'pending' ? (
                    <>
                      <p className="muted">{APPROVE_HINT}</p>
                      <p className="muted">{REJECT_HINT}</p>
                      <DecideApplicantForm
                        publisherId={a.publisher_id}
                        name={a.display_name}
                        hasCode={mfa}
                      />
                    </>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
        <div className="pk-panel pk-add">
          <h3>{ADD_HEADING}</h3>
          <AddApplicantForm hasCode={mfa} />
        </div>
      </section>
      {publishers.length === 0 ? (
        <p className="muted" id="ops-pub-list" data-testid="publishers-empty">
          {PUBLISHERS_EMPTY}
        </p>
      ) : (
        <div className="pk-section pk-stack" id="ops-pub-list">
          {publishers.map((p) => {
            const payee = {
              last4: p.payee_last4,
              verified: p.payee_verified_at !== null,
              shared: p.payee_shared,
            };
            const payeeView = payeeChip(payee);
            const agreement = agreementOf.get(p.publisher_id) ?? null;
            const agreementView = agreementChip(agreement, PUBLISHER_TERMS_VERSION);
            return (
              <section
                key={p.publisher_id}
                className="pk-panel"
                aria-labelledby={`pub-${p.publisher_id}`}
                data-testid="publisher-row"
              >
                <div className="pk-item-head">
                  <h2 id={`pub-${p.publisher_id}`}>{p.display_name}</h2>
                  <div className="pk-chips">
                    <Chip tone={publisherStatusTone(p.status)} testId="publisher-row-status">
                      {statusText(p.status)}
                    </Chip>
                    <Chip tone={payeeView.tone}>{payeeView.text}</Chip>
                    <Chip tone={agreementView.tone}>{agreementView.text}</Chip>
                  </div>
                </div>
                <dl className="pk-facts">
                  <dt>{LABEL_PAYEE}</dt>
                  <dd>
                    <span className="mono">{maskedMerchant(p.payee_last4)}</span> {payeeText(payee)}
                  </dd>
                  <dt>{LABEL_SETTLEMENT}</dt>
                  <dd data-testid="publisher-row-settlement">{p.settlement.sentence}</dd>
                  <dt>{LABEL_OFFERS}</dt>
                  <dd>{offersText(p.offers_live)}</dd>
                </dl>
                <PublisherTermsLine agreement={agreement} />
                <h3 className="pk-sub">{LABEL_MONEY}</h3>
                {p.by_currency.length === 0 ? (
                  <p className="muted">{NO_PAYMENTS}</p>
                ) : (
                  p.by_currency.map((b) => (
                    <div
                      key={`${b.currency}-${b.environment}`}
                      className="pk-money"
                      data-testid="exposure-row"
                    >
                      <h4>
                        {COL_CURRENCY}: {b.currency} ({envText(b.environment)})
                      </h4>
                      <dl className="pk-facts">
                        <dt>{COL_CAPTURED}</dt>
                        <dd>{unitsText(b.units_captured)}</dd>
                        <dt>{COL_NOT_REFUNDED}</dt>
                        <dd>{formatMinor(b.captured_not_refunded_minor, b.currency)}</dd>
                        <dt>{COL_REFUNDS_OPEN}</dt>
                        <dd>
                          {b.refunds_open_count === 0
                            ? NONE_CELL
                            : countAmountText(
                                b.refunds_open_count,
                                formatMinor(b.refunds_open_minor, b.currency),
                              )}
                        </dd>
                        <dt>{COL_HELD}</dt>
                        <dd>
                          {b.held_count === 0
                            ? NONE_CELL
                            : countAmountText(b.held_count, formatMinor(b.held_minor, b.currency))}
                        </dd>
                        {/* MC2-L6 (D-083): of the held units, those PayPal keeps for the seller to accept. */}
                        {(() => {
                          const a = awaiting.find(
                            (x) =>
                              x.publisher_id === p.publisher_id &&
                              x.currency === b.currency &&
                              x.environment === b.environment,
                          );
                          return a === undefined ? null : (
                            <>
                              <dt>{COL_AWAITING}</dt>
                              <dd data-testid="exposure-awaiting">
                                {countAmountText(a.count, formatMinor(a.minor, b.currency))}
                              </dd>
                            </>
                          );
                        })()}
                      </dl>
                    </div>
                  ))
                )}
                {p.status === 'applied' ? (
                  <p className="muted">{APPLIED_HINT}</p>
                ) : (
                  <details className="pk-details" open={p.status === 'suspended'}>
                    <summary>{STATUS_DETAILS_SUMMARY}</summary>
                    <p className="muted">
                      {p.status === 'suspended' ? REACTIVATE_HINT : SUSPEND_HINT}
                    </p>
                    <StatusForm
                      publisherId={p.publisher_id}
                      name={p.display_name}
                      suspended={p.status === 'suspended'}
                      hasCode={mfa}
                    />
                  </details>
                )}
              </section>
            );
          })}
        </div>
      )}
      <p className="pk-links">
        <Link href="/ops">{PUBLISHERS_BACK_LINK}</Link>
      </p>
    </>
  );
}
