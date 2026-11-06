import type { OpsPayouts } from '../../server/access';
import { formatDateTime, formatMinor } from '../../lib/format';
import {
  PAYOUTS_DRYRUN_NOTE,
  PAYOUTS_EMPTY,
  PAYOUTS_LEDE,
  PAYOUTS_SANDBOX_NOTE,
  PAYOUT_COLUMNS,
  PAYOUT_STATE_LABEL,
  PAYOUT_STATE_TONE,
} from '../../lib/payout-copy';
import { Chip, StatTile } from '../../ui/publisher/kit';
import { EnvChip, TableScroll } from '../publisher/pk-sales-parts';

// POB-M1 (D-089): payouts for Operations, read only. Counts by state, then the newest payouts. The environment word comes from
// the stored environment of the page and of each row. No payee id is shown.
export function PayoutsPanel({ view }: { view: OpsPayouts }) {
  const states = ['due', 'sending', 'sent', 'confirmed', 'failed', 'cancelled'] as const;
  return (
    <>
      <p className="oh-lede">{PAYOUTS_LEDE}</p>
      <p className="muted" data-testid="ops-payouts-note">
        {view.environment === 'dryrun' ? PAYOUTS_DRYRUN_NOTE : PAYOUTS_SANDBOX_NOTE}
      </p>
      <ul className="pk-tiles oh-tiles" aria-label="Payouts by state">
        {states.map((s) => (
          <li key={s} className={`oh-tone-${PAYOUT_STATE_TONE[s]}`}>
            <StatTile
              label={PAYOUT_STATE_LABEL[s]}
              value={view.counts[s]}
              testId={`ops-payouts-${s}`}
            />
          </li>
        ))}
      </ul>
      {view.rows.length === 0 ? (
        <p className="oh-empty">{PAYOUTS_EMPTY}</p>
      ) : (
        <TableScroll label="Payouts">
          <table className="pk-table" data-testid="ops-payouts-table">
            <caption className="visually-hidden">Payouts</caption>
            <thead>
              <tr>
                <th scope="col">{PAYOUT_COLUMNS.publisher}</th>
                <th scope="col" className="pk-num">
                  {PAYOUT_COLUMNS.amount}
                </th>
                <th scope="col">{PAYOUT_COLUMNS.state}</th>
                <th scope="col" className="pk-num">
                  {PAYOUT_COLUMNS.sales}
                </th>
                <th scope="col">{PAYOUT_COLUMNS.created}</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.id}>
                  <td data-label={PAYOUT_COLUMNS.publisher}>{r.publisher_name}</td>
                  <td className="pk-num" data-label={PAYOUT_COLUMNS.amount}>
                    {formatMinor(r.amount_minor, r.currency)}{' '}
                    <EnvChip environment={r.environment} />
                  </td>
                  <td data-label={PAYOUT_COLUMNS.state}>
                    <Chip tone={PAYOUT_STATE_TONE[r.state]}>{PAYOUT_STATE_LABEL[r.state]}</Chip>
                  </td>
                  <td className="pk-num" data-label={PAYOUT_COLUMNS.sales}>
                    {r.items}
                  </td>
                  <td className="pk-nowrap" data-label={PAYOUT_COLUMNS.created}>
                    {formatDateTime(r.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </>
  );
}
