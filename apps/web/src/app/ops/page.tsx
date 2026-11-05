import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../server/session';
import { readHomeLights, readNeedsYou, readOpsHome } from '../../composition/ops-home';
import { HealthLights } from '../../ui/ops/HealthLights';
import { EnvLabel } from '../../ui/EnvLabel';
import { formatDateTime } from '../../lib/format';
import { EVALS_OPS_LINK } from '../../lib/evals-copy';
import { OPS_LINK_PAYEE_REQUESTS, OPS_LINK_PUBLISHERS } from '../../lib/ops-publishers-copy';
import {
  OPS_CARD_EVALS_TEXT,
  OPS_CARD_PAYEE_TEXT,
  OPS_CARD_PUBLISHERS_TEXT,
} from '../../lib/ops-publishers-view';
import { ActionCard, Chip, PageHeader, Section } from '../../ui/publisher/kit';
import { OPS_HOME_KILL_STATE_LABEL, statusWord, switchChip } from '../../lib/ops-home-copy';
import { SHELL_MOVES, stubFor } from '../../lib/shell-moves';
import { SectionNav } from '../../ui/SectionNav';
import { OPS_HOME_SECTIONS } from '../../lib/ops-copy';
import { KillControls } from './KillControls';
import '../publisher/pk-sales.css';
import './pk-opshome.css';
import '../../ui/ops/ops-a.css';

export const metadata: Metadata = { title: 'Operations' };

/**
 * INT-UI0: the stub Home keeps for a block that moved to another tab. The server never sees a #fragment, so
 * an old bookmark such as /ops#ops-switches lands here: one sentence and a link to the same id on the new
 * page. The table of moves is lib/shell-moves.ts.
 */
function MovedStub({ id, to }: { id: string; to: string }) {
  const move = SHELL_MOVES.find((m) => m.id === id && m.to === to && m.moved);
  if (move === undefined) throw new Error(`no move for ${id} to ${to}`);
  const s = stubFor(move);
  return (
    <section id={id} className="pk-panel oh-stub" data-testid={`ops-stub-${id}`}>
      <p>
        {s.text} <Link href={s.href}>{s.link}</Link>
      </p>
    </section>
  );
}

export default async function Ops() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops');
  const read = await readOpsHome(actor);
  if (read === null) redirect('/signin?next=/ops');
  const { snap, flagOff } = read;
  const lights = await readHomeLights(actor);
  const needsYou = await readNeedsYou();
  const killChip = switchChip('paypal_outbound', snap.kill_switch.outbound_on, flagOff);
  return (
    <>
      <PageHeader
        title="Operations"
        aside={<EnvLabel environment={snap.environment} />}
        lede="Read only, except the start and stop buttons and, with the authenticator code, refunds. Everything else is changed with the operator command line."
      />
      <SectionNav label="Sections of this page" items={OPS_HOME_SECTIONS} />
      <HealthLights lights={lights} />
      <Section title="Needs you" id="ops-needs-you">
        {needsYou.length === 0 ? (
          <p className="oh-empty" data-testid="needs-you-empty">
            Nothing is waiting for you.
          </p>
        ) : (
          <ul className="ola-needs" data-testid="needs-you">
            {needsYou.map((r) => (
              <li key={`${r.kind}-${r.sentence}`}>
                <Link className="ola-row-link" href={r.href}>
                  {r.sentence}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
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
          <KillControls
            outboundOn={snap.kill_switch.outbound_on}
            hasCode={actor.mfa === true}
            activeScope={snap.kill_switch.active_scope}
            flagOff={flagOff}
          />
        </div>
      </Section>

      <Section title="Alerts" id="ops-alerts">
        <p>
          <Link href="/ops/alerts">See all alerts</Link>
        </p>
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

      <Section title="Moved to other tabs" id="ops-moved">
        <ul className="oh-stubs">
          <li>
            <MovedStub id="ops-switches" to="/ops/controls" />
          </li>
          <li>
            <MovedStub id="ops-gate-section" to="/ops/controls" />
          </li>
          <li>
            <MovedStub id="ops-refunds" to="/ops/money" />
          </li>
          <li>
            <MovedStub id="ops-orders" to="/ops/money" />
          </li>
          <li>
            <MovedStub id="ops-totals" to="/ops/money" />
          </li>
          <li>
            <MovedStub id="ops-states" to="/ops/money" />
          </li>
          <li>
            <MovedStub id="ops-invariants" to="/ops/money" />
          </li>
          <li>
            <MovedStub id="ops-shared-payee" to="/ops/sellers" />
          </li>
        </ul>
      </Section>
    </>
  );
}
