import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../../../server/session';
import { readLedgerList } from '../../../../composition/ops-money';
import { EnvLabel } from '../../../../ui/EnvLabel';
import { PageHeader, Section } from '../../../../ui/publisher/kit';
import { SectionNav } from '../../../../ui/SectionNav';
import { formatMinor } from '../../../../lib/format';
import { OPS_LEDGER_SECTIONS } from '../../../../lib/ops-money-view';
import { TableScroll } from '../../../publisher/pk-sales-parts';
import '../../../tables.css';
import '../../../publisher/pk-sales.css';
import '../../pk-opshome.css';

export const metadata: Metadata = { title: 'Ledger' };

// INT-OPS-C / OPS-C.4: the ledger lines behind one total of the Money tab: one environment, one currency, one kind.
// The label comes from the stored environment. Without the authenticator code capture and refund ids show as their
// last four. Any other query is 404.
export default async function OpsLedger({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/money');
  const read = await readLedgerList(actor, await searchParams);
  if (read === null) notFound();
  return (
    <>
      <PageHeader
        title={`${read.kind_word}, ${read.currency}`}
        aside={<EnvLabel environment={read.environment} />}
        lede={`${String(read.count)} lines, ${formatMinor(read.total_minor, read.currency)} in all.${read.capped ? ' The newest are shown.' : ''}`}
      />
      <SectionNav label="Sections of this page" items={OPS_LEDGER_SECTIONS} />
      <Section title="Lines" id="ledger-lines">
        <p>
          <Link href="/ops/money">Back to Money</Link>
        </p>
        {read.lines.length === 0 ? (
          <p className="oh-empty">No lines.</p>
        ) : (
          <TableScroll label="Ledger lines">
            <table className="pk-table" aria-label="Ledger lines">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Capture</th>
                  <th scope="col">Refund</th>
                  <th scope="col">Booked</th>
                </tr>
              </thead>
              <tbody>
                {read.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="mono" data-label="Order">
                      <Link href={l.order_href}>{l.order_ref}</Link>
                    </td>
                    <td className="pk-num" data-label="Amount">
                      {formatMinor(l.amount_minor, read.currency)}
                    </td>
                    <td className="mono" data-label="Capture">
                      {l.capture ?? ''}
                    </td>
                    <td className="mono" data-label="Refund">
                      {l.refund ?? ''}
                    </td>
                    <td data-label="Booked">{l.created_at.slice(0, 16).replace('T', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>
    </>
  );
}
