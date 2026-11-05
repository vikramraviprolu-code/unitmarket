import {
  PERFORMANCE_COLUMNS,
  PERFORMANCE_EMPTY,
  PERFORMANCE_HEADING,
  PERFORMANCE_LEDE,
  SEVERAL_ARTICLES_NOTE,
} from '../../lib/seller-offer-view';
import { formatMinor, optionLabel } from '../../lib/format';
import type { PerformanceView } from '../../composition/seller';

// INT-SEL / SEL.8: per offer and way of buying, the last 30 days. Net is the statement net of each offer's share.
export function OfferPerformance({ rows }: { rows: readonly PerformanceView[] }) {
  return (
    <section aria-labelledby="perf-h" className="pk-section" data-testid="offer-performance">
      <h2 id="perf-h">{PERFORMANCE_HEADING}</h2>
      <p className="pk-lede">{PERFORMANCE_LEDE}</p>
      {rows.length === 0 ? (
        <p className="muted">{PERFORMANCE_EMPTY}</p>
      ) : (
        <>
          <div
            className="pk-table-scroll"
            tabIndex={0}
            role="region"
            aria-label={PERFORMANCE_HEADING}
          >
            <table className="pk-table">
              <caption className="visually-hidden">{PERFORMANCE_HEADING}</caption>
              <thead>
                <tr>
                  <th scope="col">{PERFORMANCE_COLUMNS.offer}</th>
                  <th scope="col">{PERFORMANCE_COLUMNS.option}</th>
                  <th scope="col" className="pk-num">
                    {PERFORMANCE_COLUMNS.units}
                  </th>
                  <th scope="col" className="pk-num">
                    {PERFORMANCE_COLUMNS.gross}
                  </th>
                  <th scope="col" className="pk-num">
                    {PERFORMANCE_COLUMNS.refunds}
                  </th>
                  <th scope="col" className="pk-num">
                    {PERFORMANCE_COLUMNS.net}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.offer_id}-${r.option}`}>
                    <td>{r.title}</td>
                    <td>{optionLabel(r.option)}</td>
                    <td className="pk-num">{String(r.units)}</td>
                    <td className="pk-num">{formatMinor(r.gross_minor, r.currency)}</td>
                    <td className="pk-num">
                      {formatMinor(r.refunds_minor + r.reversals_minor, r.currency)}
                    </td>
                    <td className="pk-num">
                      <strong>{formatMinor(r.net_minor, r.currency)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">{SEVERAL_ARTICLES_NOTE}</p>
        </>
      )}
    </section>
  );
}
