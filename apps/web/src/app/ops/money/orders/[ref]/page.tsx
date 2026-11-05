import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { currentActor } from '../../../../../server/session';
import { readOrderPage } from '../../../../../composition/ops-money';
import { EnvLabel } from '../../../../../ui/EnvLabel';
import { Chip, PageHeader, Section } from '../../../../../ui/publisher/kit';
import { Timeline } from '../../../../../ui/Timeline';
import { OPS_NEEDS_CODE } from '../../../../../lib/ops-copy';
import '../../../../tables.css';
import '../../../../publisher/pk-sales.css';
import '../../../pk-opshome.css';

export const metadata: Metadata = { title: 'Order' };

// INT-OPS-A / OPS-A.4: the operator order page. A summary, the timeline of the order, one evidence button for each
// unit and the one fix link of an alert on the order. Operators only. An operator without the authenticator code
// reads it, with no buyer name, no whole PayPal id and no address (the view leaves them out).
export default async function OpsOrder({ params }: { params: Promise<{ ref: string }> }) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/money');
  const { ref } = await params;
  const view = await readOrderPage(actor, decodeURIComponent(ref));
  if (view === null) notFound();
  return (
    <>
      <PageHeader
        title={`Order ${view.order_ref}`}
        aside={<EnvLabel environment={view.environment as 'dryrun' | 'sandbox'} />}
        lede={`${view.status}, ${view.total_text}, placed ${view.created_text}.`}
      />
      <p className="ola-toolbar">
        <Link href="/ops/money">Money</Link>
        {view.fix !== null ? (
          <Link className="btn btn-primary" href={view.fix.href} data-testid="order-fix">
            {view.fix.label}
          </Link>
        ) : null}
        {view.alerts.map((a) => (
          <Link key={a.id} href={a.href}>
            Open alert {a.id}
          </Link>
        ))}
      </p>
      <Section title="Summary" id="order-summary">
        <dl className="pk-facts">
          <dt>Status</dt>
          <dd>{view.status}</dd>
          <dt>Total</dt>
          <dd>{view.total_text}</dd>
          {view.buyer !== null ? (
            <>
              <dt>Buyer</dt>
              <dd data-testid="order-buyer">{view.buyer}</dd>
            </>
          ) : null}
          {view.provider_ids.map((p) => (
            <div key={p.label}>
              <dt>{p.label}</dt>
              <dd className="mono">{p.value}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title="Units" id="order-units">
        <ul className="oh-list">
          {view.units.map((u) => (
            <li key={u.id} className="oh-check" data-testid="order-unit">
              <span className="mono">{u.id}</span>
              <span>{u.amount_text}</span>
              <Chip tone="neutral">{u.status}</Chip>
              {u.evidence.href === null ? (
                <button type="button" className="btn" disabled={!u.evidence.enabled}>
                  {u.evidence.label}
                </button>
              ) : (
                <a className="btn" href={u.evidence.href}>
                  {u.evidence.label}
                </a>
              )}
            </li>
          ))}
        </ul>
        {view.units.some((u) => !u.evidence.enabled) ? (
          <p className="ola-hint">The evidence pack {OPS_NEEDS_CODE}.</p>
        ) : null}
      </Section>
      <Section title="Timeline" id="order-timeline">
        <Timeline view={view.timeline} label={`Timeline of order ${view.order_ref}`} />
      </Section>
      {view.request_details.length > 0 ? (
        <Section title="Where the steps came from" id="order-requests">
          <ul className="oh-list">
            {view.request_details.map((d) => (
              <li key={d.seq} className="oh-check">
                <span>Step {d.seq}</span>
                <span className="mono">{d.req_id ?? 'no request id'}</span>
                <span className="mono">{d.address ?? 'no address'}</span>
                <span>{d.browser ?? 'no browser'}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}
