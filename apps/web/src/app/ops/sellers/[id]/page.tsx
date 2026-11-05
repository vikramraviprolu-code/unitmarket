import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../../../server/session';
import { readSellerPage } from '../../../../composition/ops-sellers';
import { EnvLabel } from '../../../../ui/EnvLabel';
import { PageHeader, Section } from '../../../../ui/publisher/kit';
import { SectionNav } from '../../../../ui/SectionNav';
import { EntitySummary } from '../../../../ui/ops/EntitySummary';
import { formatMinor } from '../../../../lib/format';
import { OPS_SELLER_PAGE_SECTIONS, sellerFacts } from '../../../../lib/ops-entity-view';
import { TableScroll } from '../../../publisher/pk-sales-parts';
import '../../../tables.css';
import '../../../publisher/pk-sales.css';
import '../../pk-opshome.css';

export const metadata: Metadata = { title: 'Seller' };

// INT-OPS-C / OPS-C.2: one seller: offers, sales, payee status and agreement version. It shows no buyer identity
// with or without the code. The seller's own name and the whole merchant id need the authenticator code.
export default async function OpsSeller({ params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/sellers');
  const { id } = await params;
  const read = await readSellerPage(actor, decodeURIComponent(id));
  if (read === null) notFound();
  const title = read.seller.display_name ?? `Seller ${read.seller.id}`;
  return (
    <>
      <PageHeader
        title={title}
        aside={<EnvLabel environment={read.environment} />}
        lede={
          read.mfa
            ? `Seller ${read.seller.id} (${read.seller.slug ?? ''}).`
            : 'The seller name and the whole payee id need your authenticator code.'
        }
      />
      <SectionNav label="Sections of this page" items={OPS_SELLER_PAGE_SECTIONS} />
      <EntitySummary
        label="About this seller"
        facts={sellerFacts({
          payee: read.payee,
          agreement: read.agreement,
          offers: read.offers.length,
          sales: read.sales.length,
        })}
      />
      <Section title="Offers" id="seller-offers">
        {read.offers.length === 0 ? (
          <p className="oh-empty">No offers.</p>
        ) : (
          <TableScroll label="Offers of this seller">
            <table className="pk-table" aria-label="Offers of this seller">
              <thead>
                <tr>
                  <th scope="col">Offer</th>
                  <th scope="col">Title</th>
                  <th scope="col">Version</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {read.offers.map((o) => (
                  <tr key={o.id}>
                    <td className="mono" data-label="Offer">
                      {o.id}
                    </td>
                    <td data-label="Title">{o.title}</td>
                    <td data-label="Version">{o.version}</td>
                    <td data-label="Status">{o.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>
      <Section title="Sales" id="seller-sales">
        {read.sales.length === 0 ? (
          <p className="oh-empty">No sales yet.</p>
        ) : (
          <TableScroll label="Sales of this seller">
            <table className="pk-table" aria-label="Sales of this seller">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Status</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Refunded</th>
                </tr>
              </thead>
              <tbody>
                {read.sales.map((s) => (
                  <tr key={s.unit_id}>
                    <td className="mono" data-label="Order">
                      <Link href={`/ops/money/orders/${encodeURIComponent(s.order_ref)}`}>
                        {s.order_ref}
                      </Link>
                    </td>
                    <td data-label="Status">{s.status}</td>
                    <td className="pk-num" data-label="Amount">
                      {formatMinor(s.amount_minor, s.currency)}
                    </td>
                    <td className="pk-num" data-label="Refunded">
                      {formatMinor(s.refunded_minor, s.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>
    </>
  );
}
