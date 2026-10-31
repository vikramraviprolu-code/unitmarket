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
import { ActionCard, Chip, PageHeader, Section, StatTile } from '../../ui/publisher/kit';
import {
  OPS_HOME_HEADING_SWITCHES,
  OPS_HOME_KILL_STATE_LABEL,
  OPS_HOME_ORDERS_LIST_HEADING,
  OPS_HOME_STATES_NOTE,
  OPS_HOME_SWITCHES_LEDE,
  invariantChip,
  invariantDetailText,
  invariantsSummary,
  operationTiles,
  orderStatusChip,
  orderTiles,
  ordersNote,
  statusWord,
  switchChip,
  switchView,
} from '../../lib/ops-home-copy';
import { StopButton } from './StopButton';
import { RefundPanel } from './RefundPanel';
import '../tables.css';
import '../publisher/pk-sales.css';
import { TableScroll } from '../publisher/pk-sales-parts';
import './pk-opshome.css';

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
  const killChip = switchChip('paypal_outbound', snap.kill_switch.outbound_on);
  const invariants = invariantsSummary(snap.invariants);
  const statusTiles = orderTiles(snap.orders);
  const stateTiles = operationTiles(snap.operations);
  return (
    <>
      <PageHeader
        title="Operations"
        aside={<EnvLabel environment={snap.environment} />}
        lede="Read only, except the stop button and, with the authenticator code, refunds. Everything else is changed with the operator command line."
      />
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

      <Section title={OPS_HOME_HEADING_SWITCHES} id="ops-switches">
        <p className="oh-lede">{OPS_HOME_SWITCHES_LEDE}</p>
        <ul className="oh-grid" aria-label="Safety switches">
          {Object.entries(snap.switches).map(([name, on]) => {
            const v = switchView(name, on);
            return (
              <li key={name}>
                <div className="pk-panel oh-switch" data-testid={`ops-switch-${name}`}>
                  <p className="oh-switch-name">{v.label}</p>
                  <p className="oh-code">{v.name}</p>
                  <Chip tone={v.chip.tone}>{v.chip.text}</Chip>
                  {v.hint ? <p className="oh-hint">{v.hint}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Kill switch" id="ops-kill">
        <div className="oh-split">
          <div className="pk-panel" data-testid="ops-kill-switch">
            <div className="oh-state-row">
              <p>{OPS_HOME_KILL_STATE_LABEL}</p>
              <Chip tone={killChip.tone}>{killChip.text}</Chip>
            </div>
            <dl className="pk-facts oh-kill-facts">
              <dt>Last change (paypal_outbound)</dt>
              <dd>
                {snap.kill_switch.outbound_on ? 'On' : 'Off'}. Last changed by{' '}
                {snap.kill_switch.changed_by}
                {snap.kill_switch.changed_at ? (
                  <>
                    , <span className="oh-time">{formatDateTime(snap.kill_switch.changed_at)}</span>
                  </>
                ) : null}
                . {snap.kill_switch.reason}
              </dd>
              <dt>Calls left today under the active approval</dt>
              <dd>
                {snap.kill_switch.budget === null
                  ? 'No active approval.'
                  : `${snap.kill_switch.budget.remaining_today} of ${snap.kill_switch.budget.max_calls_per_day}, valid until ${formatDateTime(snap.kill_switch.budget.valid_until)}`}
              </dd>
              <dt>Job loop</dt>
              <dd>
                {snap.jobs.last_pass_at === null ? (
                  'No pass finished yet.'
                ) : (
                  <>
                    Last pass{' '}
                    <span className="oh-time">{formatDateTime(snap.jobs.last_pass_at)}</span>.
                  </>
                )}{' '}
                {snap.jobs.due} due.
              </dd>
            </dl>
          </div>
          <div className="pk-panel oh-stop">
            <StopButton />
          </div>
        </div>
      </Section>

      {snap.shared_payee === null ? null : (
        <p className="pk-note" data-testid="ops-shared-payee">
          {snap.shared_payee.publishers === 2
            ? 'Both publishers'
            : `All ${String(snap.shared_payee.publishers)} publishers`}{' '}
          are paid into the owner&apos;s {envWord(snap.environment)} account (…
          {snap.shared_payee.last4}).
        </p>
      )}

      <Section title="Outbound approval gate" id="ops-gate-section">
        <div className="pk-panel">
          <ul className="oh-list" data-testid="ops-gate">
            {gateLines(snap.gate).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      </Section>

      <div className="pk-section oh-refunds">
        {snap.refunds === null ? (
          <section aria-labelledby="refunds-heading">
            <h2 id="refunds-heading">Refunds</h2>
            <p className="pk-panel" data-testid="refund-no-mfa">
              Refunds need a sign-in with your authenticator code. This session has none. Sign out
              and sign in again as a named operator with the code to see the refund form.
            </p>
          </section>
        ) : (
          <RefundPanel overview={snap.refunds} keys={refundKeys} />
        )}
      </div>

      <Section title="Orders" id="ops-orders">
        {snap.orders.length === 0 ? (
          <p className="oh-empty">No orders yet.</p>
        ) : (
          <>
            <ul className="pk-tiles oh-tiles" aria-label="Orders by status">
              {statusTiles.map((t) => (
                <li key={t.key} className={`oh-tone-${t.tone}`}>
                  <StatTile
                    label={t.label}
                    value={t.count}
                    note={ordersNote(t.count, t.key)}
                    testId={`ops-orders-${t.key}`}
                  />
                </li>
              ))}
            </ul>
            <h3 className="oh-sub">{OPS_HOME_ORDERS_LIST_HEADING}</h3>
            <TableScroll label="Latest orders">
              <table className="pk-table oh-orders-table">
                <caption className="visually-hidden">Latest orders</caption>
                <thead>
                  <tr>
                    <th scope="col">Reference</th>
                    <th scope="col">Status</th>
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.orders.map((o) => {
                    const chip = orderStatusChip(o.status);
                    return (
                      <tr key={o.order_ref}>
                        <td className="mono order-ref" data-label="Reference">
                          {o.order_ref}
                        </td>
                        <td data-label="Status">
                          <Chip tone={chip.tone}>{chip.text}</Chip>
                        </td>
                        <td className="pk-num" data-label="Total">
                          {formatMinor(o.total_minor, o.currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </>
        )}
      </Section>

      <Section title="Operations by state" id="ops-states">
        {stateTiles.length === 0 ? (
          <p className="oh-empty">None.</p>
        ) : (
          <ul className="pk-tiles oh-tiles" aria-label="Operations by state">
            {stateTiles.map((t) => (
              <li key={t.key} className={`oh-tone-${t.tone}`}>
                <StatTile
                  label={t.label}
                  value={t.count}
                  note={OPS_HOME_STATES_NOTE}
                  testId={`ops-operations-${t.key}`}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Alerts" id="ops-alerts">
        {snap.alerts.length === 0 ? (
          <p className="oh-empty">No alerts.</p>
        ) : (
          <div className="pk-panel">
            <ul className="oh-list">
              {snap.alerts.map((a, i) => (
                <li key={i} className="oh-check">
                  <Chip tone="warn">{statusWord(a.kind)}</Chip>
                  <span className="oh-check-detail">{formatDateTime(a.created_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="Invariants" id="ops-invariants">
        <div className="oh-summary">
          <Chip tone={invariants.chip.tone}>{invariants.chip.text}</Chip>
          <p data-testid="ops-invariants-summary">{invariants.text}</p>
        </div>
        <div className="pk-panel">
          <ul className="oh-list">
            {snap.invariants.map((v) => {
              const c = invariantChip(v.ok);
              return (
                <li key={v.id} className="oh-check">
                  <Chip tone={c.tone}>{c.text}</Chip>
                  <span className="oh-check-id">{v.id}</span>
                  <span className="oh-check-detail">{invariantDetailText(v.detail, v.ok)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </Section>
    </>
  );
}
