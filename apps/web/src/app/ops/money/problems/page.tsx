import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { currentActor } from '../../../../server/session';
import { readProblems } from '../../../../composition/ops-money';
import { Chip, PageHeader, Section } from '../../../../ui/publisher/kit';
import {
  INVARIANT_WORDS,
  OPERATION_WORDS,
  parseProblemsQuery,
} from '../../../../lib/ops-invariants-view';
import { formatDateTime } from '../../../../lib/format';
import '../../../tables.css';
import '../../../publisher/pk-sales.css';
import '../../pk-opshome.css';

export const metadata: Metadata = { title: 'Problems' };

// INT-OPS-A / OPS-A.6: what is behind a failing check or an operation state on Money. A failing invariant lists the
// orders its rows lead to; a state lists its operations. A list is cut at 200 and says how many there are. It names
// orders and operations only, so an operator without the authenticator code reads it too.
export default async function OpsProblems({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/money/problems');
  const query = parseProblemsQuery(await searchParams);
  const p = await readProblems(actor, query);
  if (p === null) redirect('/signin?next=/ops/money/problems');
  return (
    <>
      <PageHeader
        title="Problems"
        lede="The orders and operations behind a failing check on Money."
      />
      <p>
        <Link href="/ops/money">Back to Money</Link>
      </p>
      {p.kind === 'none' ? (
        <>
          <Section title="Checks" id="problems-checks">
            <ul className="oh-list">
              {p.invariants.map((v) => (
                <li key={v.id} className="oh-check">
                  <Chip tone={v.ok ? 'good' : 'bad'}>{v.ok ? 'Holds' : 'Failing'}</Chip>
                  <span className="oh-check-id">{v.id}</span>
                  <span>{INVARIANT_WORDS[v.id]}</span>
                  {v.href !== null ? <Link href={v.href}>See the orders</Link> : null}
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Operations by state" id="problems-states">
            <ul className="oh-list">
              {p.states.map((s) => (
                <li key={s.state} className="oh-check">
                  <span>{OPERATION_WORDS[s.state]}</span>
                  <span>{s.count}</span>
                  {s.count > 0 ? <Link href={s.href}>See the operations</Link> : null}
                </li>
              ))}
            </ul>
          </Section>
        </>
      ) : null}
      {p.kind === 'inv' ? (
        <Section title={`${p.id}: ${INVARIANT_WORDS[p.id]}`} id="problems-invariant">
          <p role="status" data-testid="problems-total">
            {p.ok
              ? 'This check holds. There is nothing to list.'
              : `${String(p.total)} ${p.total === 1 ? 'order' : 'orders'} behind this check.`}
          </p>
          {p.ok ? null : <p className="muted">{p.detail}</p>}
          {p.capped ? <p className="muted">Showing the first 200.</p> : null}
          <ul className="oh-list">
            {p.orders.map((o) => (
              <li key={o.order_ref} className="oh-check" data-testid="problem-order">
                <Link href={o.href}>{o.order_ref}</Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {p.kind === 'op' ? (
        <Section title={`Operations: ${OPERATION_WORDS[p.state]}`} id="problems-operations">
          <p role="status" data-testid="problems-total">
            {p.total === 0
              ? 'No operations are in this state.'
              : `${String(p.total)} ${p.total === 1 ? 'operation' : 'operations'}.`}
          </p>
          {p.capped ? <p className="muted">Showing the first 200.</p> : null}
          {p.operations.length === 0 ? null : (
            <table className="pk-table">
              <caption className="visually-hidden">Operations in this state</caption>
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Order</th>
                  <th scope="col">Attempt</th>
                  <th scope="col">Lease until</th>
                </tr>
              </thead>
              <tbody>
                {p.operations.map((o) => (
                  <tr key={o.id} data-testid="problem-operation">
                    <td className="mono" data-label="Operation">
                      {o.id}
                    </td>
                    <td data-label="Kind">{o.kind.replace(/_/g, ' ')}</td>
                    <td data-label="Order">
                      <Link href={o.order_href}>{o.order_ref}</Link>
                    </td>
                    <td data-label="Attempt">{o.attempt}</td>
                    <td data-label="Lease until">
                      {o.lease_until === null ? 'none' : formatDateTime(o.lease_until)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      ) : null}
    </>
  );
}
