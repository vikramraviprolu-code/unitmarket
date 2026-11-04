import type { FigureRow, OpsReportingView } from '../../lib/ops-reporting-view';
import {
  OPS_REPORTING_BOOKED_CAPTION,
  OPS_REPORTING_COLUMNS,
  OPS_REPORTING_HEADING,
  OPS_REPORTING_VIEW_CAPTION,
} from '../../lib/ops-reporting-view';
import { EnvChip, TableScroll } from '../publisher/pk-sales-parts';

// MC2-L7: the words and figures come from opsReportingView; this only lays them out. The environment word
// is from the stored environment (EnvChip), never typed here. One table for each environment keeps the
// booked rows and the reporting view on the same four columns, with the numbers and their headings right
// aligned; a row group heading tells the two apart.
function FigureRows({
  caption,
  rows,
  testId,
}: {
  caption: string;
  rows: readonly FigureRow[];
  testId: string;
}) {
  return (
    <tbody data-testid={testId}>
      <tr className="oh-totals-sub">
        <th scope="rowgroup" colSpan={4}>
          {caption}
        </th>
      </tr>
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
          <TableScroll label={`${OPS_REPORTING_HEADING} ${g.environment}`}>
            <table
              className="pk-table oh-totals"
              data-testid={`ops-reporting-table-${g.environment}`}
            >
              <caption className="visually-hidden">{OPS_REPORTING_HEADING}</caption>
              <colgroup>
                <col className="oh-totals-c0" />
                <col className="oh-totals-c" />
                <col className="oh-totals-c" />
                <col className="oh-totals-c" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Currency</th>
                  <th scope="col" className="pk-num">
                    {OPS_REPORTING_COLUMNS.sales}
                  </th>
                  <th scope="col" className="pk-num">
                    {OPS_REPORTING_COLUMNS.refunds}
                  </th>
                  <th scope="col" className="pk-num">
                    {OPS_REPORTING_COLUMNS.exposure}
                  </th>
                </tr>
              </thead>
              <FigureRows
                caption={OPS_REPORTING_BOOKED_CAPTION}
                rows={g.booked}
                testId={`ops-reporting-booked-${g.environment}`}
              />
              {g.reporting === null ? null : (
                <FigureRows
                  caption={OPS_REPORTING_VIEW_CAPTION}
                  rows={g.reporting.rows}
                  testId={`ops-reporting-view-${g.environment}`}
                />
              )}
            </table>
          </TableScroll>
          {g.reporting === null ? (
            <p className="pk-note" data-testid="ops-reporting-missing">
              {g.missing_note}
            </p>
          ) : (
            <p className="pk-note" data-testid="ops-reporting-rate">
              {g.reporting.rate_note} {g.reporting.how_note}
            </p>
          )}
        </div>
      ))}
      <p className="pk-note" data-testid="ops-reporting-statements">
        {view.statements_note}
      </p>
    </div>
  );
}
