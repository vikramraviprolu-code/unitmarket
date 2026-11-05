import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { readPendingApprovals } from '../../../composition/buyer';
import { approvalsModel } from '../../../lib/buyer-should-view';
import { PageHeader, Section } from '../../../ui/publisher/kit';

export const metadata: Metadata = { title: 'Approvals' };

// INT-BUY / BUY.7: the approvals inbox. It lists the approvals that wait for the buyer's OK and links each to the
// existing /approve/[id] page, which does the approving. Read only.
export default async function BuyerApprovals() {
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect('/signin?next=/buyer/approvals');
  const a = await app();
  const model = approvalsModel(await readPendingApprovals(actor.buyer_id), a.security.clock.now());
  return (
    <>
      <PageHeader
        title="Approvals"
        lede="Purchases that wait for your OK. You pay nothing until you approve."
      />
      <Section title="Waiting for your OK" id="approvals">
        {model.empty !== null ? (
          <p data-testid="approvals-empty">{model.empty}</p>
        ) : (
          <ul aria-label="Approvals waiting for your OK">
            {model.rows.map((r) => (
              <li key={r.key} data-testid="approval-row">
                <Link href={r.href}>{r.text}</Link> <span className="muted">{r.note}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
