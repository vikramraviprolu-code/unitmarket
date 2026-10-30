import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import '../../tables.css';
import { app, salesTotals } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EmptyState } from '../../../ui/EmptyState';
import { EnvLabel } from '../../../ui/EnvLabel';
import { formatDateTime, formatMinor, optionLabel } from '../../../lib/format';
import {
  blockHeading,
  feeText,
  NAV_HOME,
  NAV_STATEMENT,
  SALES_COLUMNS,
  SALES_EMPTY_BODY,
  SALES_EMPTY_TITLE,
  SALES_HEADING,
  SALES_LEDE,
  SALES_ORDER_NOTE,
  SALES_SOURCE_NOTE,
  TOTALS_COLUMNS,
  TOTALS_HEADING,
  TOTALS_NOTE,
  mismatchSalesText,
  notCountedText,
  salesCountText,
  splitSales,
} from '../../../lib/statement-copy';
import { DownloadCsv } from '../DownloadCsv';
import {
  EXPORT_NOTE,
  EXPORT_SALES_HREF,
  EXPORT_SALES_LABEL,
  REFUNDS_COLUMNS,
  REFUNDS_HEADING,
  REFUNDS_LEDE,
  REFUNDS_SOURCE_NOTE,
  refundsCountText,
} from '../../../lib/publisher-e1-copy';

export const metadata: Metadata = { title: 'Sales' };

// PUB-C, S4: the units the signed-in publisher sold. The page reads no parameter: the publisher id
// is the session's, and the engine filters every query by it. No buyer is named anywhere.
export default async function PublisherSales() {
  const actor = await currentActor();
  if (actor?.kind !== 'publisher') redirect('/signin?next=/publisher/sales');
  const a = await app();
  const all = await a.engine.publisherSales(actor);
  if (all === null) redirect('/signin?next=/publisher/sales');
  // PUB-E1: the refunds, apart from the sales, from the stored ledger rows.
  const refunds = (await a.engine.publisherRefunds(actor)) ?? [];
  // GATE35 D6: only paid units are counted and listed; the rest is one note.
  // PUB-F1: the totals row is the statement read model, so S4 and S5 show the same numbers.
  const statement = await a.engine.publisherStatement(actor);
  if (statement === null) redirect('/signin?next=/publisher/sales');
  const totals = salesTotals(statement.blocks);
  const { counted: rows, notCounted } = splitSales(all);
  const mismatchCount = rows.filter((r) => r.status === 'mismatch').length;
  // The label follows the stored environment of the rows; with no rows, the app's.
  const environments = [...new Set(all.map((r) => r.environment))].sort();
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
      <p>
        <DownloadCsv href={EXPORT_SALES_HREF} label={EXPORT_SALES_LABEL} testId="export-sales" />
      </p>
      <p className="muted">{EXPORT_NOTE}</p>
      {rows.length === 0 ? (
        <EmptyState title={SALES_EMPTY_TITLE}>{SALES_EMPTY_BODY}</EmptyState>
      ) : (
        <>
          <p role="status" data-testid="sales-count">
            {salesCountText(rows.length)}
          </p>
          <p className="table-hint muted">Scroll sideways to see more</p>
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
                    <td>{feeText(r.paypal_fee_minor, r.currency, r.environment)}</td>
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
      {totals.length > 0 ? (
        <section data-testid="sales-totals">
          <h2>{TOTALS_HEADING}</h2>
          <div className="table-scroll">
            <table>
              <caption className="visually-hidden">{TOTALS_HEADING}</caption>
              <thead>
                <tr>
                  <th scope="col">{TOTALS_COLUMNS.group}</th>
                  <th scope="col">{TOTALS_COLUMNS.units}</th>
                  <th scope="col">{TOTALS_COLUMNS.gross}</th>
                  <th scope="col">{TOTALS_COLUMNS.refunds}</th>
                  <th scope="col">{TOTALS_COLUMNS.reversals}</th>
                  <th scope="col">{TOTALS_COLUMNS.net}</th>
                  <th scope="col">{TOTALS_COLUMNS.fee}</th>
                </tr>
              </thead>
              <tbody>
                {totals.map((t) => (
                  <tr key={`${t.currency}-${t.environment}`}>
                    <td>
                      {blockHeading(t.currency, t.environment)}{' '}
                      <EnvLabel environment={t.environment} />
                    </td>
                    <td>{String(t.units_paid)}</td>
                    <td>{formatMinor(t.gross_minor, t.currency)}</td>
                    <td>{formatMinor(t.refunds_minor, t.currency)}</td>
                    <td>{formatMinor(t.reversals_minor, t.currency)}</td>
                    <td data-testid="sales-totals-net">
                      <strong>{formatMinor(t.net_minor, t.currency)}</strong>
                    </td>
                    <td>{feeText(t.paypal_fee_minor, t.currency, t.environment)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">{TOTALS_NOTE}</p>
        </section>
      ) : null}
      {mismatchCount > 0 ? (
        <p className="muted" data-testid="sales-mismatch">
          {mismatchSalesText(mismatchCount)}
        </p>
      ) : null}
      {notCounted.length > 0 ? (
        <p className="muted" data-testid="sales-not-counted">
          {notCountedText(notCounted.length)}
        </p>
      ) : null}
      <h2 id="refunds">{REFUNDS_HEADING}</h2>
      <p className="lede">{REFUNDS_LEDE}</p>
      <p role="status" data-testid="refunds-count">
        {refundsCountText(refunds.length)}
      </p>
      {refunds.length === 0 ? null : (
        <>
          <div className="table-scroll">
            <table data-testid="refunds-table">
              <caption className="visually-hidden">{REFUNDS_HEADING}</caption>
              <thead>
                <tr>
                  <th scope="col">{REFUNDS_COLUMNS.date}</th>
                  <th scope="col">{REFUNDS_COLUMNS.order}</th>
                  <th scope="col">{REFUNDS_COLUMNS.article}</th>
                  <th scope="col">{REFUNDS_COLUMNS.original}</th>
                  <th scope="col">{REFUNDS_COLUMNS.refunded}</th>
                  <th scope="col">{REFUNDS_COLUMNS.reversed}</th>
                  <th scope="col">{REFUNDS_COLUMNS.status}</th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((r, i) => (
                  <tr key={`${r.order_ref6}-${String(i)}`}>
                    <td>{formatDateTime(r.at)}</td>
                    <td className="mono">{r.order_ref6}</td>
                    <td>
                      {r.items.map((it, k) => (
                        <div key={`${it.title}-${String(k)}`}>{it.title}</div>
                      ))}
                    </td>
                    <td>{formatMinor(r.amount_minor, r.currency)}</td>
                    <td>{formatMinor(r.refunded_minor, r.currency)}</td>
                    <td>{formatMinor(r.reversed_minor, r.currency)}</td>
                    <td>{r.status_text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">{REFUNDS_SOURCE_NOTE}</p>
        </>
      )}
    </>
  );
}
