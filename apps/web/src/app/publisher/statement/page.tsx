import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EmptyState } from '../../../ui/EmptyState';
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
  blockHeading,
  feeText,
  salesAnchor,
  visibleLines,
} from '../../../lib/statement-copy';
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
      <h1>{STATEMENT_HEADING}</h1>
      <p className="lede">{STATEMENT_LEDE}</p>
      <p>
        <Link href="/publisher/sales">{NAV_SALES}</Link>
        {' | '}
        <Link href="/publisher">{NAV_HOME}</Link>
        {' | '}
        <a href={EXPORT_STATEMENT_HREF} download>
          {EXPORT_STATEMENT_LABEL}
        </a>
      </p>
      <p className="muted">{EXPORT_NOTE}</p>
      {statement.blocks.length === 0 ? (
        <>
          <p>
            <EnvLabel environment={statement.environment} />
          </p>
          <EmptyState title={STATEMENT_EMPTY_TITLE}>{STATEMENT_EMPTY_BODY}</EmptyState>
          <div className="card">
            <h2>{SETTLEMENT_HEADING}</h2>
            <p data-testid="settlement-sentence">{statement.settlement.sentence}</p>
          </div>
        </>
      ) : (
        statement.blocks.map((b) => (
          <section
            key={`${b.currency}-${b.environment}`}
            className="card"
            data-testid="statement-block"
          >
            <h2>
              {blockHeading(b.currency, b.environment)} <EnvLabel environment={b.environment} />
            </h2>
            <p data-testid="settlement-sentence">
              <strong>{SETTLEMENT_HEADING}:</strong> {b.settlement.sentence}
            </p>
            <dl>
              <dt>{LINE_LABEL.sales}</dt>
              <dd>
                {formatMinor(b.sales_minor, b.currency)}
                <span className="muted"> {LINE_SOURCE.sales}</span>
              </dd>
              <dt>{LINE_LABEL.refunds}</dt>
              <dd>
                {formatMinor(b.refunds_minor, b.currency)}
                <span className="muted"> {LINE_SOURCE.refunds}</span>
              </dd>
              <dt>{LINE_LABEL.reversals}</dt>
              <dd>
                {formatMinor(b.reversals_minor, b.currency)}
                <span className="muted"> {LINE_SOURCE.reversals}</span>
              </dd>
              <dt>{LINE_LABEL.fee}</dt>
              <dd>
                {feeText(b.paypal_fee_minor, b.currency, b.environment)}
                <span className="muted"> {LINE_SOURCE.fee}</span>
              </dd>
              <dt>{LINE_LABEL.net}</dt>
              <dd data-testid="statement-net">
                <strong>{formatMinor(b.net_minor, b.currency)}</strong>
                <span className="muted"> {LINE_SOURCE.net}</span>
              </dd>
            </dl>
            <h3>{LINES_HEADING}</h3>
            <div className="table-scroll">
              <table>
                <caption className="visually-hidden">{LINES_HEADING}</caption>
                <thead>
                  <tr>
                    <th scope="col">{LINES_COLUMNS.date}</th>
                    <th scope="col">{LINES_COLUMNS.order}</th>
                    <th scope="col">{LINES_COLUMNS.entry}</th>
                    <th scope="col">{LINES_COLUMNS.amount}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLines(b.lines, b.environment).map((l, i) => (
                    <tr key={`${l.order_ref6}-${l.kind}-${String(i)}`}>
                      <td>{formatDateTime(l.at)}</td>
                      <td className="mono">
                        <Link href={salesAnchor(l.order_ref6)}>{l.order_ref6}</Link>
                      </td>
                      <td>{ENTRY_TEXT[l.kind]}</td>
                      <td>{formatMinor(l.amount_minor, b.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
      <h2>{COMMISSION_HEADING}</h2>
      <p data-testid="commission-line">{statement.commission}</p>
    </>
  );
}
