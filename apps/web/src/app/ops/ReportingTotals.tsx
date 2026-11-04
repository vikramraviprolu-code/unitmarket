import type { FigureRow, OpsReportingView } from '../../lib/ops-reporting-view';
import {
  OPS_REPORTING_BOOKED_CAPTION,
  OPS_REPORTING_COLUMNS,
  OPS_REPORTING_VIEW_CAPTION,
} from '../../lib/ops-reporting-view';
import { EnvChip, TableScroll } from '../publisher/pk-sales-parts';

// MC2-L7: the words and figures come from opsReportingView; this only lays them out. The environment word
// is from the stored environment (EnvChip), never typed here.
function FigureTable({
  caption,
  rows,
  testId,
}: {
  caption: string;
  rows: readonly FigureRow[];
  testId: string;
}) {
  return (
    <TableScroll label={caption}>
      <table className="pk-table" data-testid={testId}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Currency</th>
            <th scope="col">{OPS_REPORTING_COLUMNS.sales}</th>
            <th scope="col">{OPS_REPORTING_COLUMNS.refunds}</th>
            <th scope="col">{OPS_REPORTING_COLUMNS.exposure}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row" data-label="Currency">
                {r.label}
              </th>
              <td className="pk-num" data-label={OPS_REPORTING_COLUMNS.sales}>
                {r.sales}
              </td>
              <td className="pk-num" data-label={OPS_REPORTING_COLUMNS.refunds}>
                {r.refunds}
              </td>
              <td className="pk-num" data-label={OPS_REPORTING_COLUMNS.exposure}>
                {r.exposure}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export function ReportingTotals({ view }: { view: OpsReportingView }) {
  return (
    <div data-testid="ops-reporting">
      {view.empty !== null ? <p className="oh-empty">{view.empty}</p> : null}
      {view.groups.map((g) => (
        <div key={g.environment} data-testid={`ops-reporting-${g.environment}`}>
          <h3 className="oh-sub">
            <EnvChip environment={g.environment} />
          </h3>
          <FigureTable
            caption={OPS_REPORTING_BOOKED_CAPTION}
            rows={g.booked}
            testId={`ops-reporting-booked-${g.environment}`}
          />
          {g.reporting === null ? (
            <p className="pk-note" data-testid="ops-reporting-missing">
              {g.missing_note}
            </p>
          ) : (
            <>
              <FigureTable
                caption={OPS_REPORTING_VIEW_CAPTION}
                rows={g.reporting.rows}
                testId={`ops-reporting-view-${g.environment}`}
              />
              <p className="pk-note" data-testid="ops-reporting-rate">
                {g.reporting.rate_note} {g.reporting.how_note}
              </p>
            </>
          )}
        </div>
      ))}
      <p className="pk-note" data-testid="ops-reporting-statements">
        {view.statements_note}
      </p>
    </div>
  );
}
