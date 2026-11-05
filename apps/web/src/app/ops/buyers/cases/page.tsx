import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { currentActor } from '../../../../server/session';
import { readCaseQueue, readNow } from '../../../../composition/ops-buyers';
import { Chip, PageHeader } from '../../../../ui/publisher/kit';
import { TableScroll } from '../../../publisher/pk-sales-parts';
import { caseQuery, caseQueueView, parseCaseFilter } from '../../../../lib/ops-cases-view';
import '../../../tables.css';
import '../../../publisher/pk-sales.css';
import '../../pk-opshome.css';
import '../../../../ui/ops/ops-a.css';

export const metadata: Metadata = { title: 'Cases' };

// INT-OPS-A / OPS-A.5: the case queue, soonest SLA first. It never carries the text of a message to a buyer; that is
// on the case page. An operator without the authenticator code reads it too.
export default async function OpsCases({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/buyers/cases');
  const filter = parseCaseFilter(await searchParams);
  const queue = await readCaseQueue(caseQuery(filter));
  const view = caseQueueView(queue, filter, await readNow(actor));
  return (
    <>
      <PageHeader title="Cases" lede="Buyers who need help, soonest due first." />
      <nav className="ola-toolbar" aria-label="Case state">
        <ul>
          {view.filters.map((f) => (
            <li key={f.state}>
              <Link href={f.href} aria-current={f.current ? 'true' : undefined}>
                {f.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p role="status" data-testid="cases-total">
        {view.total_text}
      </p>
      {view.rows.length === 0 ? null : (
        <TableScroll label="Cases">
          <table className="pk-table">
            <caption className="visually-hidden">Cases, soonest due first</caption>
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">State</th>
                <th scope="col">Due</th>
                <th scope="col">Order</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.case_id} data-testid="case-row">
                  <td data-label="Case">
                    <Link href={r.href}>{r.kind_word}</Link>
                  </td>
                  <td data-label="State">{r.state_word}</td>
                  <td data-label="Due">
                    {r.sla_text} {r.late ? <Chip tone="bad">Late</Chip> : null}
                  </td>
                  <td data-label="Order">
                    {r.order_href === null ? 'none' : <Link href={r.order_href}>{r.order_ref}</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </>
  );
}
