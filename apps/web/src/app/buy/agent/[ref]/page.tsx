import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../../server/access';
import { readCapLine } from '../../../../composition/buyer';
import { currentActor } from '../../../../server/session';
import { resolveHandoff } from '../../../../api-v1/agent-handoff';
import { OrderStatus } from '../../../orders/[ref]/OrderStatus';
import { PayButton } from './PayButton';

export const metadata: Metadata = { title: 'Order from your agent' };

// API-B: the page an agent's buy_unit points the buyer to in sandbox mode. Buyer only; 404 for anyone else.
export default async function AgentHandoffPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const r = await resolveHandoff(await app(), await currentActor(), ref);
  if (r.kind === 'signin') redirect(`/signin?next=${encodeURIComponent(r.next)}`);
  if (r.kind === 'not_found') notFound();
  // INT-BUY / BUY.2: what is left of the cap this order was booked against, or nothing when it used no cap.
  const actor = await currentActor();
  const line = actor?.kind === 'buyer' ? await readCapLine(actor.buyer_id, ref) : null;
  return (
    <>
      <h1>Your agent started this order</h1>
      <p>
        Your agent chose this unit within the spending cap you set. Nothing is charged until you pay
        here.
      </p>
      {line !== null ? <p data-testid="cap-line">{line}</p> : null}
      <OrderStatus initial={r.view} />
      {r.can_pay && r.view.status === 'created' ? <PayButton order={r.view} /> : null}
    </>
  );
}
