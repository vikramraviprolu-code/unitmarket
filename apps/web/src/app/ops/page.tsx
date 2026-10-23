import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../server/access';
import { currentActor } from '../../server/session';
import { EnvLabel } from '../../ui/EnvLabel';
import { formatMinor, formatDateTime } from '../../lib/format';
import { gateLines } from '../../lib/gate-lines';
import { StopButton } from './StopButton';

export const metadata: Metadata = { title: 'Operations' };

export default async function Ops() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops');
  const snap = await (await app()).engine.opsSnapshot(actor);
  if (snap === null) redirect('/signin?next=/ops');
  return (
    <>
      <h1>
        Operations <EnvLabel environment={snap.environment} />
      </h1>
      <p className="muted">
        Read only, except the stop button below. Everything else is changed with the operator
        command line.
      </p>

      <h2>Switches</h2>
      <table>
        <caption className="visually-hidden">Safety switches</caption>
        <thead>
          <tr>
            <th scope="col">Switch</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(snap.switches).map(([name, on]) => (
            <tr key={name}>
              <td className="mono">{name}</td>
              <td>{on ? 'On' : 'Off'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Kill switch</h2>
      <dl data-testid="ops-kill-switch">
        <dt>Outbound PayPal calls (paypal_outbound)</dt>
        <dd>
          {snap.kill_switch.outbound_on ? 'On' : 'Off'}. Last changed by{' '}
          {snap.kill_switch.changed_by}
          {snap.kill_switch.changed_at
            ? `, ${formatDateTime(snap.kill_switch.changed_at)}`
            : ''}. {snap.kill_switch.reason}
        </dd>
        <dt>Calls left today under the active approval</dt>
        <dd>
          {snap.kill_switch.budget === null
            ? 'No active approval.'
            : `${snap.kill_switch.budget.remaining_today} of ${snap.kill_switch.budget.max_calls_per_day}, valid until ${formatDateTime(snap.kill_switch.budget.valid_until)}`}
        </dd>
        <dt>Job loop</dt>
        <dd>
          {snap.jobs.last_pass_at === null
            ? 'No pass finished yet.'
            : `Last pass ${formatDateTime(snap.jobs.last_pass_at)}.`}{' '}
          {snap.jobs.due} due.
        </dd>
      </dl>

      <h2>Outbound approval gate</h2>
      <ul data-testid="ops-gate">
        {gateLines(snap.gate).map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>

      <StopButton />

      <h2>Orders</h2>
      {snap.orders.length === 0 ? (
        <p className="muted">No orders yet.</p>
      ) : (
        <table>
          <caption className="visually-hidden">Latest orders</caption>
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Status</th>
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {snap.orders.map((o) => (
              <tr key={o.order_ref}>
                <td className="mono">{o.order_ref}</td>
                <td>{o.status}</td>
                <td>{formatMinor(o.total_minor, o.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Operations by state</h2>
      <p>
        {snap.operations.length === 0
          ? 'None.'
          : snap.operations.map((o) => `${o.state}: ${o.count}`).join(', ')}
      </p>

      <h2>Alerts</h2>
      {snap.alerts.length === 0 ? (
        <p className="muted">No alerts.</p>
      ) : (
        <ul>
          {snap.alerts.map((a, i) => (
            <li key={i}>
              {a.kind}, {formatDateTime(a.created_at)}
            </li>
          ))}
        </ul>
      )}

      <h2>Invariants</h2>
      <p data-testid="ops-invariants-summary">
        {snap.invariants.every((v) => v.ok)
          ? 'All hold.'
          : `${snap.invariants.filter((v) => !v.ok).length} failing.`}
      </p>
      <ul>
        {snap.invariants.map((v) => (
          <li key={v.id}>
            {v.id}: {v.ok ? 'ok' : 'FAILED'}. {v.detail}
          </li>
        ))}
      </ul>
    </>
  );
}
