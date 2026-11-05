import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import '../../../tables.css';
import '../../pk-sales.css';
import { readSellerSale } from '../../../../composition/seller';
import { currentActor } from '../../../../server/session';
import { saleView } from '../../../../lib/seller-sale-view';
import { SaleDetail } from '../../../../ui/seller/SaleDetail';

export const metadata: Metadata = { title: 'Sale' };

// INT-SEL / SEL.1: one sale of the signed-in seller. A unit of another seller, or one that does not exist, gives
// the same 404, so the page does not say which. The unit id in the address is only a key to look up.
export default async function SellerSale({ params }: { params: Promise<{ unit: string }> }) {
  const { unit } = await params;
  const actor = await currentActor();
  if (actor?.kind !== 'publisher') redirect('/signin?next=/publisher/sales');
  const r = await readSellerSale(actor, unit);
  if (r.kind === 'forbidden') redirect('/signin?next=/publisher/sales');
  if (r.kind === 'not_found') notFound();
  return <SaleDetail view={saleView(r.sale)} />;
}
