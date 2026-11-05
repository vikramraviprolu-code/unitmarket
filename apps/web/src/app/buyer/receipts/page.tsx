import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { currentActor } from '../../../server/session';
import { readReceipts } from '../../../composition/buyer';
import { receiptsModel } from '../../../lib/buyer-should-view';
import { PageHeader, Section } from '../../../ui/publisher/kit';

export const metadata: Metadata = { title: 'Receipts' };

// INT-BUY / BUY.6: the receipts of the buyer's paid orders: order ref, provider order id, seller of record, and links
// to the receipt and the order. Read only.
export default async function BuyerReceipts() {
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect('/signin?next=/buyer/receipts');
  const model = receiptsModel(await readReceipts(actor.buyer_id));
  return (
    <>
      <PageHeader
        title="Receipts"
        lede="One receipt for each paid order, with the PayPal order id and the seller you paid."
      />
      <Section title="Your receipts" id="receipts">
        {model.empty !== null ? (
          <p data-testid="receipts-empty">{model.empty}</p>
        ) : (
          <table aria-label="Your receipts" data-testid="receipts-table">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">PayPal order id</th>
                <th scope="col">Seller</th>
                <th scope="col">Amount</th>
                <th scope="col">Date</th>
                <th scope="col">Links</th>
              </tr>
            </thead>
            <tbody>
              {model.rows.map((r) => (
                <tr key={r.key} data-testid="receipt-row">
                  <td>{r.order_ref}</td>
                  <td>{r.provider_order_id}</td>
                  <td>{r.seller}</td>
                  <td>{r.money_text}</td>
                  <td>{r.date_text}</td>
                  <td>
                    <Link href={r.receipt_href}>Receipt</Link>{' '}
                    <Link href={r.order_href}>Order</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}
