import Link from 'next/link';
import type { AlertListView } from '../../lib/ops-alerts-view';
import { alertsHref } from '../../lib/ops-alerts-view';
import { Chip } from '../publisher/kit';
import type { Tone } from '../publisher/kit';
import { TableScroll } from '../../app/publisher/pk-sales-parts';
import './ops-a.css';

const TONE: Record<string, Tone> = {
  critical: 'bad',
  high: 'warn',
  medium: 'info',
  info: 'neutral',
};
const STATES = [
  ['open', 'Open'],
  ['acknowledged', 'Acknowledged'],
  ['resolved', 'Resolved'],
  ['all', 'All'],
] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'info'] as const;

// INT-OPS-A / OPS-A.3: the alert list. It paints what lib/ops-alerts-view.ts returns: AL's true total, the
// filters as plain links (so they work with scripts off), a "Show resolved" toggle and one fix link a row.
export function AlertList({ view }: { view: AlertListView }) {
  const f = view.filter;
  return (
    <>
      <div className="ola-toolbar">
        <nav aria-label="Alert state">
          <ul>
            {STATES.map(([state, label]) => (
              <li key={state}>
                <Link
                  href={alertsHref({ ...f, state })}
                  aria-current={f.state === state ? 'true' : undefined}
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Alert severity">
          <ul>
            <li>
              <Link
                href={alertsHref({
                  state: f.state,
                  ...(f.kind === undefined ? {} : { kind: f.kind }),
                })}
                aria-current={f.severity === undefined ? 'true' : undefined}
              >
                Any severity
              </Link>
            </li>
            {SEVERITIES.map((s) => (
              <li key={s}>
                <Link
                  href={alertsHref({ ...f, severity: s })}
                  aria-current={f.severity === s ? 'true' : undefined}
                >
                  {s}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <Link href={view.show_resolved.href} data-testid="alerts-show-resolved">
          {view.show_resolved.on ? 'Hide resolved' : 'Show resolved'}
        </Link>
      </div>
      <p data-testid="alerts-total" role="status">
        {view.total_text}
      </p>
      {view.rows.length === 0 ? null : (
        <TableScroll label="Alerts">
          <table className="pk-table">
            <caption className="visually-hidden">Alerts, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Alert</th>
                <th scope="col">Severity</th>
                <th scope="col">State</th>
                <th scope="col">Raised</th>
                <th scope="col">Fix</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.id} data-testid="alert-row">
                  <td data-label="Alert">
                    <Link href={r.href}>{r.title}</Link>
                  </td>
                  <td data-label="Severity">
                    <Chip tone={TONE[r.severity] ?? 'neutral'}>{r.severity_word}</Chip>
                  </td>
                  <td data-label="State">{r.state_word}</td>
                  <td data-label="Raised">{r.when}</td>
                  <td data-label="Fix">
                    <Link href={r.fix_href}>Open the fix</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      {view.next_href === null ? null : (
        <p>
          <Link href={view.next_href} data-testid="alerts-next">
            Next alerts
          </Link>
        </p>
      )}
    </>
  );
}
