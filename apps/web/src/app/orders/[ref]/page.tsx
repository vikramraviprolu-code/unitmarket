import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { OrderStatus } from './OrderStatus';

export const metadata: Metadata = { title: 'Order' };

export default async function OrderPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect(`/signin?next=${encodeURIComponent(`/orders/${ref}`)}`);
  const a = await app();
  const view = await a.engine.orderView({ order_ref: ref, actor });
  if (view === null) notFound();
  return (
    <>
      <h1>Your order</h1>
      <OrderStatus initial={view} />
    </>
  );
}
