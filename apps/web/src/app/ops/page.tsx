import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../server/access';
import { currentActor } from '../../server/session';
import { EnvLabel, envText } from '../../ui/EnvLabel';
import { formatMinor, formatDateTime } from '../../lib/format';
import { gateLines } from '../../lib/gate-lines';
import { EVALS_OPS_LINK } from '../../lib/evals-copy';
import { OPS_LINK_PAYEE_REQUESTS, OPS_LINK_PUBLISHERS } from '../../lib/ops-publishers-copy';
import {
  OPS_CARD_EVALS_TEXT,
  OPS_CARD_PAYEE_TEXT,
  OPS_CARD_PUBLISHERS_TEXT,
} from '../../lib/ops-publishers-view';
import { ActionCard } from '../../ui/publisher/kit';
import { StopButton } from './StopButton';
import { RefundPanel } from './RefundPanel';

export const metadata: Metadata = { title: 'Operations' };

// The account's kind comes from the stored environment, not from a typed word (P16).
const envWord = (environment: Parameters<typeof envText>[0]): string =>
  envText(environment).toLowerCase();

export default async function Ops() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops');
  const snap = await (await app()).engine.opsSnapshot(actor);
  if (snap === null) redirect('/signin?next=/ops');
  const a = await app();
  // One single-use Idempotency-Key per refund form, made on the server (CO-8).
  const refundKeys = snap.refunds === null ? [] : snap.refunds.units.map(() => a.engine.newKey());
  return (
    <>
      <h1>
        Operations <EnvLabel environment={snap.environment} />
      </h1>
      <p className="muted">
        Read only, except the stop button and, with the authenticator code, refunds. Everything else
        is changed with the operator command line.
      </p>
      <ul className="pk-cards">
        <li>
          <ActionCard href="/ops/evals" title={EVALS_OPS_LINK}>
            {OPS_CARD_EVALS_TEXT}
          </ActionCard>
        </li>
        <li>
          <ActionCard href="/ops/publishers" title={OPS_LINK_PUBLISHERS}>
            {OPS_CARD_PUBLISHERS_TEXT}
          </ActionCard>
        </li>
        <li>
          <ActionCard href="/ops/payee-requests" title={OPS_LINK_PAYEE_REQUESTS}>
            {OPS_CARD_PAYEE_TEXT}
          </ActionCard>
        </li>
      </ul>

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

      {snap.shared_payee === null ? null : (
        <p data-testid="ops-shared-payee">
          {snap.shared_payee.publishers === 2
            ? 'Both publishers'
            : `All ${String(snap.shared_payee.publishers)} publishers`}{' '}
          are paid into the owner&apos;s {envWord(snap.environment)} account (…
          {snap.shared_payee.last4}).
        </p>
      )}

      <h2>Outbound approval gate</h2>
      <ul data-testid="ops-gate">
        {gateLines(snap.gate).map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>

      <StopButton />

      {snap.refunds === null ? (
        <section aria-labelledby="refunds-heading">
          <h2 id="refunds-heading">Refunds</h2>
          <p data-testid="refund-no-mfa">
            Refunds need a sign-in with your authenticator code. This session has none. Sign out and
            sign in again as a named operator with the code to see the refund form.
          </p>
        </section>
      ) : (
        <RefundPanel overview={snap.refunds} keys={refundKeys} />
      )}

      <h2>Orders</h2>
      {snap.orders.length === 0 ? (
        <p className="muted">No orders yet.</p>
      ) : (
        <div className="table-scroll" role="region" aria-label="Latest orders" tabIndex={0}>
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
                  <td className="mono order-ref">{o.order_ref}</td>
                  <td>{o.status}</td>
                  <td>{formatMinor(o.total_minor, o.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
