import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EmptyState } from '../../../ui/EmptyState';
import { EnvLabel } from '../../../ui/EnvLabel';
import { SectionNav } from '../../../ui/SectionNav';
import { Chip, PageHeader, Section } from '../../../ui/publisher/kit';
import { formatDateTime } from '../../../lib/format';
import {
  HISTORY_EMPTY,
  HISTORY_HEADING,
  LABEL_ACCOUNT,
  LABEL_VERIFIED,
  LABEL_VERIFIED_BY,
  OWNER_ONLY_NOTE,
  PAYEE_HEADING,
  PAYEE_LEDE,
  accountText,
  historyLine,
  verifiedAtText,
  verifiedByText,
} from '../../../lib/payee-copy';
import {
  BACK_TO_PUBLISHER_HOME,
  PAYEE_SECTION_CURRENT,
  PAYEE_SECTION_SETTLEMENT,
  payeeChip,
  payeeEndingText,
} from '../../../lib/publisher-forms-copy';
import { RequestForm } from './RequestForm';
import { PaypalLinkForm } from './PaypalLinkForm';
import {
  LINK_HEADING,
  LINK_LEDE,
  LINK_NONE,
  LINK_NO_ACCOUNT,
  linkLine,
} from '../../../lib/publisher-accounts-copy';
import '../pk-forms.css';

export const metadata: Metadata = { title: 'Where you get paid' };

// PUB-A2 (S6): the signed-in publisher's payee, last 4 only. The id comes from the session and nowhere
// else: the page reads no parameters, and the engine filters every query by it. The payee cannot be
// changed here; the form only sends a request that an operator checks.
export default async function PayoutAccount() {
  const actor = await currentActor();
  if (actor?.kind !== 'publisher') redirect('/signin?next=/publisher/payout-account');
  const view = await (await app()).engine.payee.view(actor);
  if (view === null) redirect('/signin?next=/publisher/payout-account');
  // POB-P1: the publisher's own PayPal address. Only a publisher who claimed an account can link one.
  const account = await (await app()).engine.publisherAccounts.view(actor);
  const operatorChecked = view.history.some((h) => h.state === 'verified');
  const chip = payeeChip({
    last4: view.last4,
    verifiedAt: view.verified_at,
    operatorChecked,
  });
  return (
    <>
      <p className="pk-back">
        <Link href="/publisher">{BACK_TO_PUBLISHER_HOME}</Link>
      </p>
      <PageHeader
        title={PAYEE_HEADING}
        lede={PAYEE_LEDE}
        aside={<EnvLabel environment={view.environment} />}
      />
      <SectionNav
        label="On this page"
        items={[
          { id: 'payee-current', label: 'Your account' },
          { id: 'paypal-link', label: 'Your PayPal address' },
          { id: 'payee-settlement-section', label: 'Where sales money goes' },
          { id: 'payee-request', label: 'Ask for a change' },
          { id: 'payee-history-section', label: 'Your requests' },
        ]}
      />
      <Section title={PAYEE_SECTION_CURRENT} id="payee-current">
        <div className="pk-panel">
          <p className="pk-ending">
            <Chip tone={chip.tone}>{chip.text}</Chip>
            <span className="pk-ending-text">{payeeEndingText(view.last4)}</span>
          </p>
          <dl className="pk-facts">
            <dt>{LABEL_ACCOUNT}</dt>
            <dd data-testid="payee-account">{accountText(view.last4)}</dd>
            <dt>{LABEL_VERIFIED}</dt>
            <dd data-testid="payee-verified">
              {verifiedAtText(view.verified_at === null ? null : formatDateTime(view.verified_at))}
            </dd>
            <dt>{LABEL_VERIFIED_BY}</dt>
            <dd data-testid="payee-verified-by">{verifiedByText(operatorChecked)}</dd>
          </dl>
        </div>
      </Section>
      <Section title={LINK_HEADING} id="paypal-link">
        <div className="pk-panel">
          <p>{LINK_LEDE}</p>
          {account === null ? (
            <p data-testid="paypal-link-no-account">{LINK_NO_ACCOUNT}</p>
          ) : (
            <>
              <p data-testid="paypal-link-current">
                {account.link === null
                  ? LINK_NONE
                  : linkLine(
                      account.link.email,
                      account.link.state,
                      account.link.synthetic === true,
                    )}
              </p>
              <PaypalLinkForm />
            </>
          )}
        </div>
      </Section>
      <Section title={PAYEE_SECTION_SETTLEMENT} id="payee-settlement-section">
        <div className="pk-panel pk-note">
          <p data-testid="payee-settlement">{view.settlement.sentence}</p>
          {view.environment === 'sandbox' ? (
            <p role="status" className="muted" data-testid="payee-owner-only">
              <strong>{OWNER_ONLY_NOTE}</strong>
            </p>
          ) : null}
        </div>
      </Section>
      <RequestForm />
      <Section title={HISTORY_HEADING} id="payee-history-section">
        {view.history.length === 0 ? (
          <EmptyState title={HISTORY_EMPTY} />
        ) : (
          <div className="pk-panel">
            <ul className="pk-history" data-testid="payee-history">
              {view.history.map((h) => (
                <li key={h.request_id}>
                  {historyLine(h)} <span className="muted">{formatDateTime(h.created_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
    </>
  );
}
