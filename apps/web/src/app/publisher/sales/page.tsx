import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import '../../tables.css';
import '../pk-sales.css';
import { app, salesTotals } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EmptyState } from '../../../ui/EmptyState';
import { Chip, PageHeader, Section, StatTile } from '../../../ui/publisher/kit';
import { EnvLabel } from '../../../ui/EnvLabel';
import { formatDateTime, formatMinor, optionLabel } from '../../../lib/format';
import {
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
import { Details, EnvChip, TableScroll } from '../pk-sales-parts';
import { HOW_MADE_SUMMARY, totalsTiles, unitStatusTone } from '../../../lib/publisher-sales-view';
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
      <PageHeader
        title={SALES_HEADING}
        lede={SALES_LEDE}
        aside={
          <>
            {environments.map((e) => (
              <EnvLabel key={e} environment={e} />
            ))}
            {rows.length > 0 ? (
              <DownloadCsv
                href={EXPORT_SALES_HREF}
                label={EXPORT_SALES_LABEL}
                testId="export-sales"
              />
            ) : null}
          </>
        }
      />
      <div className="pk-sublinks">
        <Link href="/publisher/statement">{NAV_STATEMENT}</Link>
        <Link href="/publisher">{NAV_HOME}</Link>
      </div>
      {totals.length > 0 ? (
        <Section title={TOTALS_HEADING}>
          <div data-testid="sales-totals">
            {totals.map((t) => (
              <div className="pk-group" key={`${t.currency}-${t.environment}`}>
                <div className="pk-grouphead">
                  <h3>{t.currency}</h3>
                  <EnvChip environment={t.environment} />
                </div>
                <div className="pk-tiles">
                  {totalsTiles(t).map((tile) => (
                    <StatTile
                      key={tile.key}
                      label={tile.label}
                      value={
                        tile.key === 'net' ? (
                          <span data-testid="sales-totals-net">{tile.value}</span>
                        ) : (
                          tile.value
                        )
                      }
                      note={tile.note}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
      {rows.length === 0 ? (
        <Section>
          <EmptyState title={SALES_EMPTY_TITLE}>{SALES_EMPTY_BODY}</EmptyState>
        </Section>
      ) : (
        <Section>
          <p className="pk-count" role="status" data-testid="sales-count">
            {salesCountText(rows.length)}
          </p>
          <p className="table-hint pk-hint muted">Scroll sideways to see more</p>
          <TableScroll label={SALES_HEADING}>
            <table className="pk-table" data-testid="sales-table">
              <caption className="visually-hidden">{SALES_HEADING}</caption>
              <thead>
                <tr>
                  <th scope="col">{SALES_COLUMNS.date}</th>
                  <th scope="col">{SALES_COLUMNS.order}</th>
                  <th scope="col">{SALES_COLUMNS.article}</th>
                  <th scope="col">{SALES_COLUMNS.access}</th>
                  <th scope="col" className="pk-num">
                    {SALES_COLUMNS.amount}
                  </th>
                  <th scope="col" className="pk-num">
                    {SALES_COLUMNS.fee}
                  </th>
                  <th scope="col">{SALES_COLUMNS.status}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.order_ref6}-${String(i)}`} id={`order-${r.order_ref6}`}>
                    <td className="pk-nowrap" data-label={SALES_COLUMNS.date}>
                      {formatDateTime(r.at)}
                    </td>
                    <td className="mono pk-nowrap" data-label={SALES_COLUMNS.order}>
                      {r.order_ref6}
                    </td>
                    <td data-label={SALES_COLUMNS.article}>
                      {r.items.map((it, k) => (
                        <div key={`${it.title}-${String(k)}`}>{it.title}</div>
                      ))}
                    </td>
                    <td data-label={SALES_COLUMNS.access}>
                      {r.items.map((it, k) => (
                        <div key={`${it.title}-${String(k)}`}>{optionLabel(it.option)}</div>
                      ))}
                    </td>
                    <td className="pk-num" data-label={SALES_COLUMNS.amount}>
                      {formatMinor(r.amount_minor, r.currency)}
                    </td>
                    <td className="pk-num" data-label={SALES_COLUMNS.fee}>
                      {feeText(r.paypal_fee_minor, r.currency, r.environment)}
                    </td>
                    <td data-label={SALES_COLUMNS.status}>
                      <Chip tone={unitStatusTone(r.status)}>{r.status_text}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <p className="muted">{SALES_ORDER_NOTE}</p>
        </Section>
      )}
      {mismatchCount > 0 ? (
        <p className="pk-notice" data-testid="sales-mismatch">
          {mismatchSalesText(mismatchCount)}
        </p>
      ) : null}
      {notCounted.length > 0 ? (
        <p className="muted" data-testid="sales-not-counted">
          {notCountedText(notCounted.length)}
        </p>
      ) : null}
      <Section title={REFUNDS_HEADING} id="refunds">
        <p className="pk-lede">{REFUNDS_LEDE}</p>
        <p className="pk-count" role="status" data-testid="refunds-count">
          {refundsCountText(refunds.length)}
        </p>
        {refunds.length === 0 ? null : (
          <TableScroll label={REFUNDS_HEADING}>
            <table className="pk-table" data-testid="refunds-table">
              <caption className="visually-hidden">{REFUNDS_HEADING}</caption>
              <thead>
                <tr>
                  <th scope="col">{REFUNDS_COLUMNS.date}</th>
                  <th scope="col">{REFUNDS_COLUMNS.order}</th>
                  <th scope="col">{REFUNDS_COLUMNS.article}</th>
                  <th scope="col" className="pk-num">
                    {REFUNDS_COLUMNS.original}
                  </th>
                  <th scope="col" className="pk-num">
                    {REFUNDS_COLUMNS.refunded}
                  </th>
                  <th scope="col" className="pk-num">
                    {REFUNDS_COLUMNS.reversed}
                  </th>
                  <th scope="col">{REFUNDS_COLUMNS.status}</th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((r, i) => (
                  <tr key={`${r.order_ref6}-${String(i)}`}>
                    <td className="pk-nowrap" data-label={REFUNDS_COLUMNS.date}>
                      {formatDateTime(r.at)}
                    </td>
                    <td className="mono pk-nowrap" data-label={REFUNDS_COLUMNS.order}>
                      {r.order_ref6}
                    </td>
                    <td data-label={REFUNDS_COLUMNS.article}>
                      {r.items.map((it, k) => (
                        <div key={`${it.title}-${String(k)}`}>{it.title}</div>
                      ))}
                    </td>
                    <td className="pk-num" data-label={REFUNDS_COLUMNS.original}>
                      {formatMinor(r.amount_minor, r.currency)}
                    </td>
                    <td className="pk-num" data-label={REFUNDS_COLUMNS.refunded}>
                      {formatMinor(r.refunded_minor, r.currency)}
                    </td>
                    <td className="pk-num" data-label={REFUNDS_COLUMNS.reversed}>
                      {formatMinor(r.reversed_minor, r.currency)}
                    </td>
                    <td data-label={REFUNDS_COLUMNS.status}>
                      <Chip tone={unitStatusTone(r.status)}>{r.status_text}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>
      <Details summary={HOW_MADE_SUMMARY} testId="sales-how-made">
        <p className="muted">{SALES_SOURCE_NOTE}</p>
        <p className="muted">{TOTALS_NOTE}</p>
        {totals.length > 0 ? (
          <>
            <h3>{TOTALS_HEADING}</h3>
            <p className="table-hint pk-hint muted">Scroll sideways to see more</p>
            <TableScroll label={TOTALS_HEADING}>
              <table className="pk-table">
                <caption className="visually-hidden">{TOTALS_HEADING}</caption>
                <thead>
                  <tr>
                    <th scope="col">{TOTALS_COLUMNS.group}</th>
                    <th scope="col" className="pk-num">
                      {TOTALS_COLUMNS.units}
                    </th>
                    <th scope="col" className="pk-num">
                      {TOTALS_COLUMNS.gross}
                    </th>
                    <th scope="col" className="pk-num">
                      {TOTALS_COLUMNS.refunds}
                    </th>
                    <th scope="col" className="pk-num">
                      {TOTALS_COLUMNS.reversals}
                    </th>
                    <th scope="col" className="pk-num">
                      {TOTALS_COLUMNS.net}
                    </th>
                    <th scope="col" className="pk-num">
                      {TOTALS_COLUMNS.fee}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {totals.map((t) => (
                    <tr key={`${t.currency}-${t.environment}`}>
                      <td data-label={TOTALS_COLUMNS.group}>
                        {t.currency} <EnvLabel environment={t.environment} />
                      </td>
                      <td className="pk-num" data-label={TOTALS_COLUMNS.units}>
                        {String(t.units_paid)}
                      </td>
                      <td className="pk-num" data-label={TOTALS_COLUMNS.gross}>
                        {formatMinor(t.gross_minor, t.currency)}
                      </td>
                      <td className="pk-num" data-label={TOTALS_COLUMNS.refunds}>
                        {formatMinor(t.refunds_minor, t.currency)}
                      </td>
                      <td className="pk-num" data-label={TOTALS_COLUMNS.reversals}>
                        {formatMinor(t.reversals_minor, t.currency)}
                      </td>
                      <td className="pk-num" data-label={TOTALS_COLUMNS.net}>
                        <strong>{formatMinor(t.net_minor, t.currency)}</strong>
                      </td>
                      <td className="pk-num" data-label={TOTALS_COLUMNS.fee}>
                        {feeText(t.paypal_fee_minor, t.currency, t.environment)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </>
        ) : null}
        <p className="muted">{REFUNDS_SOURCE_NOTE}</p>
        <p className="muted">{EXPORT_NOTE}</p>
      </Details>
    </>
  );
}
