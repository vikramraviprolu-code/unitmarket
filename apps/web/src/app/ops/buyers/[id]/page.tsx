import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../../../server/session';
import { readBuyerPage } from '../../../../composition/ops-buyers';
import { EnvLabel } from '../../../../ui/EnvLabel';
import { PageHeader, Section } from '../../../../ui/publisher/kit';
import { SectionNav } from '../../../../ui/SectionNav';
import { EntitySummary } from '../../../../ui/ops/EntitySummary';
import { CapTable } from '../../../../ui/ops/CapTable';
import { formatMinor } from '../../../../lib/format';
import { OPS_BUYER_PAGE_SECTIONS, buyerFacts } from '../../../../lib/ops-entity-view';
import { TableScroll } from '../../../publisher/pk-sales-parts';
import '../../../tables.css';
import '../../../publisher/pk-sales.css';
import '../../pk-opshome.css';
import '../../../../ui/ops/ops-a.css';

export const metadata: Metadata = { title: 'Buyer' };

// INT-OPS-C / OPS-C.1: one buyer: orders, library count, refunds, caps and keys. It names a person, so it needs a
// sign-in with the authenticator code; without it the page shows the notice and nothing of the buyer. Read only:
// a cap is revoked from Agents and API.
/** The whole page without the code: the notice, and nothing of the buyer. */
function BuyerNotice({ notice }: { notice: string }) {
  return (
    <div className="pk-panel" data-testid="buyer-no-mfa">
      <h1>Buyer</h1>
      <p>{notice}</p>
    </div>
  );
}

export default async function OpsBuyer({ params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/buyers');
  const { id } = await params;
  const read = await readBuyerPage(actor, decodeURIComponent(id));
  if (read === null) notFound();
  if (read.kind === 'mfa_required') return <BuyerNotice notice={read.notice} />;
  return (
    <>
      <PageHeader
        title={read.buyer.display_name}
        aside={<EnvLabel environment={read.environment} />}
        lede={`Buyer ${read.buyer.id}.`}
      />
      <SectionNav label="Sections of this page" items={OPS_BUYER_PAGE_SECTIONS} />
      <EntitySummary
        label="About this buyer"
        facts={buyerFacts({
          country: read.buyer.country,
          created_at: read.buyer.created_at,
          library_count: read.library_count,
          orders: read.orders.length,
        })}
      />
      <Section title="Orders" id="buyer-orders">
        {read.orders.length === 0 ? (
          <p className="oh-empty">No orders yet.</p>
        ) : (
          <TableScroll label="Orders of this buyer">
            <table className="pk-table" aria-label="Orders of this buyer">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Status</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Items</th>
                </tr>
              </thead>
              <tbody>
                {read.orders.map((o) => (
                  <tr key={o.unit_id}>
                    <td className="mono" data-label="Order">
                      <Link href={`/ops/money/orders/${encodeURIComponent(o.order_ref)}`}>
                        {o.order_ref}
                      </Link>
                    </td>
                    <td data-label="Status">{o.status}</td>
                    <td className="pk-num" data-label="Amount">
                      {formatMinor(o.amount_minor, o.currency)}
                    </td>
                    <td data-label="Items">{o.titles.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>
      <Section title="Refunds" id="buyer-refunds">
        {read.refunds.length === 0 ? (
          <p className="oh-empty">No refunds.</p>
        ) : (
          <TableScroll label="Refunds of this buyer">
            <table className="pk-table" aria-label="Refunds of this buyer">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">State</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {read.refunds.map((r) => (
                  <tr key={r.id}>
                    <td className="mono" data-label="Order">
                      {r.order_ref}
                    </td>
                    <td data-label="State">{r.state}</td>
                    <td className="pk-num" data-label="Amount">
                      {r.amount_minor === null
                        ? 'The rest'
                        : formatMinor(r.amount_minor, r.currency)}
                    </td>
                    <td data-label="Updated">{r.updated_at.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>
      <Section title="Caps" id="buyer-caps">
        <CapTable caps={read.caps} revokeKeys={{}} />
        <p>
          <Link href="/ops/agents">Revoke a cap or key on Agents and API</Link>
        </p>
      </Section>
      <Section title="Keys" id="buyer-keys">
        {read.keys.length === 0 ? (
          <p className="oh-empty">No keys.</p>
        ) : (
          <TableScroll label="Keys of this buyer">
            <table className="pk-table" aria-label="Keys of this buyer">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Scopes</th>
                  <th scope="col">Revoked</th>
                </tr>
              </thead>
              <tbody>
                {read.keys.map((k) => (
                  <tr key={k.id}>
                    <td className="mono" data-label="Key">
                      {k.id}
                    </td>
                    <td data-label="Kind">{k.key_kind}</td>
                    <td data-label="Scopes">{k.scopes.join(', ')}</td>
                    <td data-label="Revoked">
                      {k.revoked_at === null ? 'No' : k.revoked_at.slice(0, 10)}
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
