import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import '../../tables.css';
import '../pk-sales.css';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EmptyState } from '../../../ui/EmptyState';
import { Chip, PageHeader, Section, StatTile } from '../../../ui/publisher/kit';
import { EnvLabel } from '../../../ui/EnvLabel';
import { formatDateTime, formatMinor } from '../../../lib/format';
import {
  COMMISSION_HEADING,
  ENTRY_TEXT,
  LINES_COLUMNS,
  LINES_HEADING,
  LINE_LABEL,
  LINE_SOURCE,
  NAV_HOME,
  NAV_SALES,
  SETTLEMENT_HEADING,
  STATEMENT_EMPTY_BODY,
  STATEMENT_EMPTY_TITLE,
  STATEMENT_HEADING,
  STATEMENT_LEDE,
  mismatchStatementText,
  feeText,
  salesAnchor,
  visibleLines,
} from '../../../lib/statement-copy';
import { DownloadCsv } from '../DownloadCsv';
import { Details, EnvChip, TableScroll } from '../pk-sales-parts';
import { STATEMENT_FILE_SUMMARY, ledgerKindTone } from '../../../lib/publisher-sales-view';
import {
  EXPORT_NOTE,
  EXPORT_STATEMENT_HREF,
  EXPORT_STATEMENT_LABEL,
} from '../../../lib/publisher-e1-copy';

export const metadata: Metadata = { title: 'Statement' };

// PUB-C, S5: the statement of the signed-in publisher, one block per currency. The page reads no
// parameter. Every figure is a sum of stored ledger rows; the settlement sentence and the commission
// line come from the engine, which derives them from stored data.
export default async function PublisherStatement() {
  const actor = await currentActor();
  if (actor?.kind !== 'publisher') redirect('/signin?next=/publisher/statement');
  const statement = await (await app()).engine.publisherStatement(actor);
  if (statement === null) redirect('/signin?next=/publisher/statement');
  return (
    <>
      <PageHeader
        title={STATEMENT_HEADING}
        lede={STATEMENT_LEDE}
        aside={
          statement.blocks.length > 0 ? (
            <DownloadCsv
              href={EXPORT_STATEMENT_HREF}
              label={EXPORT_STATEMENT_LABEL}
              testId="export-statement"
            />
          ) : null
        }
      />
      <div className="pk-sublinks">
        <Link href="/publisher/sales">{NAV_SALES}</Link>
        <Link href="/publisher">{NAV_HOME}</Link>
      </div>
      {statement.blocks.length === 0 ? (
        <>
          <p>
            <EnvLabel environment={statement.environment} />
          </p>
          <EmptyState title={STATEMENT_EMPTY_TITLE}>{STATEMENT_EMPTY_BODY}</EmptyState>
          <div className="pk-panel pk-block">
            <h2>{SETTLEMENT_HEADING}</h2>
            <p data-testid="settlement-sentence">{statement.settlement.sentence}</p>
          </div>
        </>
      ) : (
        statement.blocks.map((b) => (
          <section
            key={`${b.currency}-${b.environment}`}
            className="pk-panel pk-block"
            data-testid="statement-block"
          >
            <h2>
              {b.currency} <EnvChip environment={b.environment} />
            </h2>
            <p className="pk-settle" data-testid="settlement-sentence">
              <span className="pk-settle-label">{SETTLEMENT_HEADING}</span>
              {b.settlement.sentence}
            </p>
            <div className="pk-tiles pk-block-tiles">
              <StatTile label={LINE_LABEL.sales} value={formatMinor(b.sales_minor, b.currency)} />
              <StatTile
                label={LINE_LABEL.refunds}
                value={formatMinor(b.refunds_minor, b.currency)}
              />
              <StatTile label={LINE_LABEL.net} value={formatMinor(b.net_minor, b.currency)} />
            </div>
            <dl className="pk-facts">
              <dt>{LINE_LABEL.sales}</dt>
              <dd>
                <span className="pk-fig">{formatMinor(b.sales_minor, b.currency)}</span>
                <span className="pk-src">{LINE_SOURCE.sales}</span>
              </dd>
              <dt>{LINE_LABEL.refunds}</dt>
              <dd>
                <span className="pk-fig">{formatMinor(b.refunds_minor, b.currency)}</span>
                <span className="pk-src">{LINE_SOURCE.refunds}</span>
              </dd>
              <dt>{LINE_LABEL.reversals}</dt>
              <dd>
                <span className="pk-fig">{formatMinor(b.reversals_minor, b.currency)}</span>
                <span className="pk-src">{LINE_SOURCE.reversals}</span>
              </dd>
              <dt>{LINE_LABEL.net}</dt>
              <dd data-testid="statement-net">
                <strong className="pk-fig">{formatMinor(b.net_minor, b.currency)}</strong>
                <span className="pk-src">{LINE_SOURCE.net}</span>
              </dd>
              <dt>{LINE_LABEL.fee}</dt>
              <dd>
                <span className="pk-fig pk-fig-muted">
                  {feeText(b.paypal_fee_minor, b.currency, b.environment)}
                </span>
                <span className="pk-src">{LINE_SOURCE.fee}</span>
              </dd>
            </dl>
            <h3>{LINES_HEADING}</h3>
            <p className="table-hint pk-hint muted">Scroll sideways to see more</p>
            <TableScroll label={LINES_HEADING}>
              <table className="pk-table">
                <caption className="visually-hidden">{LINES_HEADING}</caption>
                <thead>
                  <tr>
                    <th scope="col">{LINES_COLUMNS.date}</th>
                    <th scope="col">{LINES_COLUMNS.order}</th>
                    <th scope="col">{LINES_COLUMNS.entry}</th>
                    <th scope="col" className="pk-num">
                      {LINES_COLUMNS.amount}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLines(b.lines, b.environment).map((l, i) => (
                    <tr key={`${l.order_ref6}-${l.kind}-${String(i)}`}>
                      <td className="pk-nowrap" data-label={LINES_COLUMNS.date}>
                        {formatDateTime(l.at)}
                      </td>
                      <td className="mono pk-nowrap" data-label={LINES_COLUMNS.order}>
                        <Link href={salesAnchor(l.order_ref6)}>{l.order_ref6}</Link>
                      </td>
                      <td data-label={LINES_COLUMNS.entry}>
                        <Chip tone={ledgerKindTone(l.kind)}>{ENTRY_TEXT[l.kind]}</Chip>
                      </td>
                      <td className="pk-num" data-label={LINES_COLUMNS.amount}>
                        {formatMinor(l.amount_minor, b.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </section>
        ))
      )}
      {statement.mismatch_units > 0 ? (
        <p className="pk-notice" data-testid="statement-mismatch">
          {mismatchStatementText(statement.mismatch_units)}
        </p>
      ) : null}
      <Section title={COMMISSION_HEADING}>
        <p data-testid="commission-line">{statement.commission}</p>
      </Section>
      <Details summary={STATEMENT_FILE_SUMMARY}>
        <p className="muted">{EXPORT_NOTE}</p>
      </Details>
    </>
  );
}
