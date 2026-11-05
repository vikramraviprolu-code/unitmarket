import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../../server/session';
import { readOpsSellers } from '../../../composition/ops-sellers';
import { EnvLabel, envText } from '../../../ui/EnvLabel';
import { OPS_LINK_PAYEE_REQUESTS, OPS_LINK_PUBLISHERS } from '../../../lib/ops-publishers-copy';
import { OPS_CARD_PAYEE_TEXT, OPS_CARD_PUBLISHERS_TEXT } from '../../../lib/ops-publishers-view';
import { ActionCard, PageHeader, Section } from '../../../ui/publisher/kit';
import { SectionNav } from '../../../ui/SectionNav';
import { OPS_SELLERS_SECTIONS } from '../../../lib/ops-copy';
import '../pk-opshome.css';

export const metadata: Metadata = { title: 'Sellers' };

// The account's kind comes from the stored environment, not from a typed word (P16).
const envWord = (environment: Parameters<typeof envText>[0]): string =>
  envText(environment).toLowerCase();

// INT-UI0: the shared payee line of the old /ops page, in a section that always exists (its id is the old
// anchor), and the links to the publishers and payee request pages that keep their URLs.
export default async function OpsSellers() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/sellers');
  const read = await readOpsSellers(actor);
  if (read === null) redirect('/signin?next=/ops/sellers');
  const { snap } = read;
  return (
    <>
      <PageHeader
        title="Sellers"
        aside={<EnvLabel environment={snap.environment} />}
        lede="The publishers who sell on UnitMarket, their payee requests and the account they are paid into."
      />
      <SectionNav label="Sections of this page" items={OPS_SELLERS_SECTIONS} />

      <Section title="Seller pages" id="ops-sellers-links">
        <ul className="pk-cards">
          <li>
            <ActionCard href="/ops/publishers" title={OPS_LINK_PUBLISHERS}>
              {OPS_CARD_PUBLISHERS_TEXT}
            </ActionCard>
          </li>
          <li>
            <ActionCard href="/ops/payee-requests" title={OPS_LINK_PAYEE_REQUESTS}>
              {OPS_CARD_PAYEE_TEXT}
            </ActionCard>
          </li>
        </ul>
      </Section>

      <Section title="Shared payee" id="ops-shared-payee">
        {snap.shared_payee === null ? (
          <p className="oh-empty">No publishers share a payee account.</p>
        ) : (
          <p className="pk-note" data-testid="ops-shared-payee">
            {snap.shared_payee.publishers === 2
              ? 'Both publishers'
              : `All ${String(snap.shared_payee.publishers)} publishers`}{' '}
            are paid into the owner&apos;s {envWord(snap.environment)} account (…
            {snap.shared_payee.last4}).
          </p>
        )}
      </Section>
    </>
  );
}
