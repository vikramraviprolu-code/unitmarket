import Link from 'next/link';
import type { SaleView } from '../../lib/seller-sale-view';
import { BACK_TO_SALES, TIMELINE_LABEL } from '../../lib/seller-sale-view';
import { Timeline } from '../Timeline';
import { EnvLabel } from '../EnvLabel';

// INT-SEL / SEL.1: one sale as the seller sees it. It paints what saleView returns and decides nothing.
// There is no buyer name, no order total and no refund reason on it, because the view holds none.
export function SaleDetail({ view }: { view: SaleView }) {
  return (
    <article aria-labelledby="sale-h" data-testid="sale-detail">
      <p>
        <Link href="/publisher/sales">{BACK_TO_SALES}</Link>
      </p>
      <h1 id="sale-h">{view.heading}</h1>
      <p>
        <EnvLabel environment={view.environment} /> <span>{view.status_text}</span>
      </p>
      <section aria-labelledby="sale-facts-h" className="pk-section">
        <h2 id="sale-facts-h">This sale</h2>
        <dl>
          <dt>Bought by</dt>
          <dd data-testid="sale-bought-by">{view.bought_by}</dd>
          <dt>Date</dt>
          <dd>{view.created_text}</dd>
        </dl>
        <table className="pk-table" data-testid="sale-items">
          <caption className="visually-hidden">Articles in this sale</caption>
          <thead>
            <tr>
              <th scope="col">Article</th>
              <th scope="col">Access</th>
            </tr>
          </thead>
          <tbody>
            {view.units.map((u, i) => (
              <tr key={`${u.title}-${String(i)}`}>
                <td>{u.title}</td>
                <td>{u.option_text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-labelledby="sale-money-h" className="pk-section">
        <h2 id="sale-money-h">Money</h2>
        <dl data-testid="sale-money">
          <dt>Sold for</dt>
          <dd>{view.gross_text}</dd>
          {view.refund === null ? null : (
            <>
              <dt>Refund</dt>
              <dd data-testid="sale-refund">
                {view.refund.amount_text}, {view.refund.state_text}, {view.refund.date_text}
              </dd>
            </>
          )}
          {view.reversals_text === null ? null : (
            <>
              <dt>Reversed</dt>
              <dd>{view.reversals_text}</dd>
            </>
          )}
          <dt>Net to you</dt>
          <dd>
            <strong data-testid="sale-net">{view.net_text}</strong>
          </dd>
          <dt>PayPal fee</dt>
          <dd>{view.fee_text}</dd>
        </dl>
        <p className="muted">The PayPal fee is shown beside the net. It is not taken from it.</p>
      </section>
      <section aria-labelledby="sale-steps-h" className="pk-section">
        <h2 id="sale-steps-h">Steps</h2>
        <Timeline view={view.timeline} label={TIMELINE_LABEL} />
      </section>
    </article>
  );
}
