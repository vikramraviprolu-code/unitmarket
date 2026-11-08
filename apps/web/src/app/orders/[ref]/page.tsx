import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { readBuyerOrder } from '../../../composition/buyer';
import { currentActor } from '../../../server/session';
import { caseCardView, reportProblemHref } from '../../../lib/buyer-order-view';
import { returnNotice } from '../../../lib/buyer-should-view';
import { app } from '../../../server/access';
import { CaseCard } from '../../../ui/buyer/CaseCard';
import { OrderStatus } from './OrderStatus';

export const metadata: Metadata = { title: 'Order' };

// INT-BUY / BUY.3: the order page keeps OrderStatus (the live status) and adds, below it, the help case with its
// steps and due time, and Report a problem. SCR-1: the step list and timeline block was removed.
// The reads come through the buyer composition module and are the buyer's own: another buyer's order is a 404.
export default async function OrderPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect(`/signin?next=${encodeURIComponent(`/orders/${ref}`)}`);
  const read = await readBuyerOrder(actor.buyer_id, ref);
  if (read === null) notFound();
  const now = (await app()).security.clock.now();
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
