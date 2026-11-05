import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../../server/session';
import { readOpsMoney } from '../../../composition/ops-money';
import { EnvLabel } from '../../../ui/EnvLabel';
import { formatMinor } from '../../../lib/format';
import { Chip, PageHeader, Section, StatTile } from '../../../ui/publisher/kit';
import {
  OPS_HOME_ORDERS_LIST_HEADING,
  OPS_HOME_STATES_NOTE,
  invariantChip,
  invariantDetailText,
  invariantsSummary,
  operationTiles,
  orderStatusChip,
  orderTiles,
  ordersNote,
} from '../../../lib/ops-home-copy';
import { SectionNav } from '../../../ui/SectionNav';
import { OPS_REPORTING_HEADING, OPS_REPORTING_LEDE } from '../../../lib/ops-reporting-view';
import { OPS_MONEY_SECTIONS } from '../../../lib/ops-copy';
import Link from 'next/link';
import { invariantLink, operationLink } from '../../../lib/ops-invariants-view';
import { RefundPanel } from '../RefundPanel';
import { ReportingTotals } from '../ReportingTotals';
import '../../tables.css';
import '../../publisher/pk-sales.css';
import { TableScroll } from '../../publisher/pk-sales-parts';
import '../pk-opshome.css';

export const metadata: Metadata = { title: 'Money' };

// INT-UI0: the refunds, orders, totals, states and invariants blocks of the old /ops page, as they were.
export default async function OpsMoney() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/money');
  const read = await readOpsMoney(actor);
  if (read === null) redirect('/signin?next=/ops/money');
  const { snap, refundKeys, reporting } = read;
  const invariants = invariantsSummary(snap.invariants);
  const statusTiles = orderTiles(snap.orders);
  const stateTiles = operationTiles(snap.operations);
  return (
    <>
      <PageHeader
        title="Money"
        aside={<EnvLabel environment={snap.environment} />}
        lede="Refunds, orders, totals and the checks that money adds up. Read only, except refunds, which need the authenticator code."
      />
      <SectionNav label="Sections of this page" items={OPS_MONEY_SECTIONS} />

      <div className="pk-section oh-refunds" id="ops-refunds">
        {snap.refunds === null ? (
          <section aria-labelledby="refunds-heading">
            <h2 id="refunds-heading">Refunds</h2>
            <p className="pk-panel" data-testid="refund-no-mfa">
              Refunds need a sign-in with your authenticator code. This session has none. Sign out
              and sign in again as a named operator with the code to see the refund form.
            </p>
          </section>
        ) : (
          <RefundPanel overview={snap.refunds} keys={refundKeys} />
        )}
      </div>

      <Section title="Orders" id="ops-orders">
        {snap.orders.length === 0 ? (
          <p className="oh-empty">No orders yet.</p>
        ) : (
          <>
            <ul className="pk-tiles oh-tiles" aria-label="Orders by status">
              {statusTiles.map((t) => (
                <li key={t.key} className={`oh-tone-${t.tone}`}>
                  <StatTile
                    label={t.label}
                    value={t.count}
                    note={ordersNote(t.count, t.key)}
                    testId={`ops-orders-${t.key}`}
                  />
                </li>
              ))}
            </ul>
            <h3 className="oh-sub">{OPS_HOME_ORDERS_LIST_HEADING}</h3>
            <TableScroll label="Latest orders">
              <table className="pk-table oh-orders-table">
                <caption className="visually-hidden">Latest orders</caption>
                <thead>
                  <tr>
                    <th scope="col">Reference</th>
                    <th scope="col">Status</th>
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.orders.map((o) => {
                    const chip = orderStatusChip(o.status);
                    return (
                      <tr key={o.order_ref}>
                        <td className="mono order-ref" data-label="Reference">
                          {o.order_ref}
                        </td>
                        <td data-label="Status">
                          <Chip tone={chip.tone}>{chip.text}</Chip>
                        </td>
                        <td className="pk-num" data-label="Total">
                          {formatMinor(o.total_minor, o.currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </>
        )}
      </Section>

      <Section title={OPS_REPORTING_HEADING} id="ops-totals">
        <p className="oh-lede">{OPS_REPORTING_LEDE}</p>
        <ReportingTotals view={reporting} />
      </Section>

      <Section title="Operations by state" id="ops-states">
        {stateTiles.length === 0 ? (
          <p className="oh-empty">None.</p>
        ) : (
          <ul className="pk-tiles oh-tiles" aria-label="Operations by state">
            {stateTiles.map((t) => (
              <li key={t.key} className={`oh-tone-${t.tone}`}>
                <StatTile
                  label={t.label}
                  value={t.count}
                  note={
                    operationLink(t.key) === null ? (
                      OPS_HOME_STATES_NOTE
                    ) : (
                      <>
                        {OPS_HOME_STATES_NOTE}{' '}
                        <Link href={operationLink(t.key)!}>See the operations</Link>
                      </>
                    )
                  }
                  testId={`ops-operations-${t.key}`}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Invariants" id="ops-invariants">
        <div className="oh-summary">
          <Chip tone={invariants.chip.tone}>{invariants.chip.text}</Chip>
          <p data-testid="ops-invariants-summary">{invariants.text}</p>
        </div>
        <div className="pk-panel">
          <p>
            <Link href="/ops/money/problems">All problems</Link>
          </p>
          <ul className="oh-list">
            {snap.invariants.map((v) => {
              const c = invariantChip(v.ok);
              return (
                <li key={v.id} className="oh-check">
                  <Chip tone={c.tone}>{c.text}</Chip>
                  <span className="oh-check-id">{v.id}</span>
                  <span className="oh-check-detail">{invariantDetailText(v.detail, v.ok)}</span>
                  {invariantLink(v.id, v.ok) !== null ? (
                    <Link href={invariantLink(v.id, v.ok)!}>See the orders</Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </Section>
    </>
  );
}
