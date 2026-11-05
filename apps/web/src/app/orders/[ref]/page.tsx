import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { readBuyerOrder, traceWords } from '../../../composition/buyer';
import { currentActor } from '../../../server/session';
import {
  buyerOrderTimeline,
  caseCardView,
  orderMilestones,
  reportProblemHref,
} from '../../../lib/buyer-order-view';
import { returnNotice } from '../../../lib/buyer-should-view';
import { app } from '../../../server/access';
import { CaseCard } from '../../../ui/buyer/CaseCard';
import { Timeline } from '../../../ui/Timeline';
import { OrderStatus } from './OrderStatus';

export const metadata: Metadata = { title: 'Order' };

// INT-BUY / BUY.3: the order page keeps OrderStatus (the live status) and adds, below it, the steps of the order in
// words from the journal (TR1), five milestones, the help case with its steps and due time, and Report a problem.
// The reads come through the buyer composition module and are the buyer's own: another buyer's order is a 404.
export default async function OrderPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect(`/signin?next=${encodeURIComponent(`/orders/${ref}`)}`);
  const read = await readBuyerOrder(actor.buyer_id, ref);
  if (read === null) notFound();
  const now = (await app()).security.clock.now();
  const timeline = buyerOrderTimeline(read.timeline, read.currency, traceWords());
  const milestones = orderMilestones(read.timeline?.entries ?? []);
  const notice = returnNotice({
    status: read.view.status,
    entitlement_id: read.entitlement_id,
    order_ref: read.view.order_ref,
  });
  const caseView = read.case === null ? null : caseCardView(read.case, now);
  return (
    <>
      <h1>Your order</h1>
      {notice.kind !== 'none' ? (
        <p className="home-section" role="status" data-testid="return-notice">
          {notice.text}{' '}
          {notice.open_now !== null ? (
            <Link className="btn btn-primary" href={notice.open_now.href} data-testid="open-now">
              {notice.open_now.label}
            </Link>
          ) : null}
        </p>
      ) : null}
      <OrderStatus initial={read.view} />
      <section aria-labelledby="order-steps" className="home-section" data-testid="order-steps">
        <h2 id="order-steps">What happened</h2>
        <ol aria-label="Milestones of your order" className="home-list" data-testid="milestones">
          {milestones.map((m) => (
            <li key={m.id}>
              {m.done ? 'Done: ' : 'Not yet: '}
              {m.label}
            </li>
          ))}
        </ol>
        <Timeline view={timeline} label="Steps of your order" />
      </section>
      {caseView !== null ? <CaseCard view={caseView} /> : null}
      <p>
        <Link
          className="btn"
          href={reportProblemHref({
            order_ref: read.view.order_ref,
            status: read.view.status,
            entitlement_id: read.entitlement_id,
          })}
          data-testid="report-problem"
        >
          Report a problem
        </Link>
      </p>
    </>
  );
}
