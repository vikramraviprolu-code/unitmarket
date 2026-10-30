import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EmptyState } from '../../../ui/EmptyState';
import { EnvLabel } from '../../../ui/EnvLabel';
import { formatDateTime, formatMinor, optionLabel } from '../../../lib/format';
import {
  FEE_NOT_REPORTED,
  NAV_HOME,
  NAV_STATEMENT,
  SALES_COLUMNS,
  SALES_EMPTY_BODY,
  SALES_EMPTY_TITLE,
  SALES_HEADING,
  SALES_LEDE,
  SALES_ORDER_NOTE,
  SALES_SOURCE_NOTE,
  salesCountText,
} from '../../../lib/statement-copy';

export const metadata: Metadata = { title: 'Sales' };

// PUB-C, S4: the units the signed-in publisher sold. The page reads no parameter: the publisher id
// is the session's, and the engine filters every query by it. No buyer is named anywhere.
export default async function PublisherSales() {
  const actor = await currentActor();
  if (actor?.kind !== 'publisher') redirect('/signin?next=/publisher/sales');
  const a = await app();
  const rows = await a.engine.publisherSales(actor);
  if (rows === null) redirect('/signin?next=/publisher/sales');
  // The label follows the stored environment of the rows; with no rows, the app's.
  const environments = [...new Set(rows.map((r) => r.environment))].sort();
  if (environments.length === 0) environments.push(a.environment);
  return (
    <>
      <h1>
        {SALES_HEADING}{' '}
        {environments.map((e) => (
          <EnvLabel key={e} environment={e} />
        ))}
      </h1>
      <p className="lede">{SALES_LEDE}</p>
      <p>
        <Link href="/publisher/statement">{NAV_STATEMENT}</Link>
        {' | '}
        <Link href="/publisher">{NAV_HOME}</Link>
      </p>
      {rows.length === 0 ? (
        <EmptyState title={SALES_EMPTY_TITLE}>{SALES_EMPTY_BODY}</EmptyState>
      ) : (
        <>
          <p role="status" data-testid="sales-count">
            {salesCountText(rows.length)}
          </p>
          <div className="table-scroll">
            <table data-testid="sales-table">
              <caption className="visually-hidden">{SALES_HEADING}</caption>
              <thead>
                <tr>
                  <th scope="col">{SALES_COLUMNS.date}</th>
                  <th scope="col">{SALES_COLUMNS.order}</th>
                  <th scope="col">{SALES_COLUMNS.article}</th>
                  <th scope="col">{SALES_COLUMNS.access}</th>
                  <th scope="col">{SALES_COLUMNS.amount}</th>
                  <th scope="col">{SALES_COLUMNS.fee}</th>
                  <th scope="col">{SALES_COLUMNS.status}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.order_ref6}-${String(i)}`} id={`order-${r.order_ref6}`}>
                    <td>{formatDateTime(r.at)}</td>
                    <td className="mono">{r.order_ref6}</td>
                    <td>
                      {r.items.map((it, k) => (
                        <div key={`${it.title}-${String(k)}`}>{it.title}</div>
                      ))}
                    </td>
                    <td>
                      {r.items.map((it, k) => (
                        <div key={`${it.title}-${String(k)}`}>{optionLabel(it.option)}</div>
                      ))}
                    </td>
                    <td>{formatMinor(r.amount_minor, r.currency)}</td>
                    <td>
                      {r.paypal_fee_minor === null
                        ? FEE_NOT_REPORTED
                        : formatMinor(r.paypal_fee_minor, r.currency)}
                    </td>
                    <td>{r.status_text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">{SALES_SOURCE_NOTE}</p>
          <p className="muted">{SALES_ORDER_NOTE}</p>
        </>
      )}
    </>
  );
}
