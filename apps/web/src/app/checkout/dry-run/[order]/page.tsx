import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { app } from '../../../../server/access';
import { currentActor } from '../../../../server/session';
import { StatusBanner } from '../../../../ui/StatusBanner';

export const metadata: Metadata = { title: 'Dry-run checkout' };

// Fixture scenarios of lane 03 that a tester can drive. Only offered when the environment is dry run.
const SCENARIOS: { id: string; label: string }[] = [
  { id: 'happy', label: 'Payment goes through' },
  { id: 'capture_202', label: 'PayPal answers "accepted" (claim only)' },
  { id: 'pending_receiving_pref', label: 'Payment pending at PayPal' },
  { id: 'lost_capture_response', label: 'Response lost, we read it back' },
  { id: 'mismatch_amount', label: 'Amount does not match (frozen)' },
  { id: 'declined', label: 'Payment declined' },
];

export default async function DryRunCheckout({ params }: { params: Promise<{ order: string }> }) {
  const { order } = await params;
  const actor = await currentActor();
  if (actor?.kind !== 'buyer')
    redirect(`/signin?next=${encodeURIComponent(`/checkout/dry-run/${order}`)}`);
  const a = await app();
  if (a.environment !== 'dryrun') notFound();
  const view = await a.engine.orderView({ order_ref: order, actor });
  if (view === null) notFound();
  return (
    <>
      <h1>Dry run: no PayPal</h1>
      <StatusBanner tone="warn" title="Dry run: no PayPal">
        This page stands in for the PayPal approval page. No PayPal page is opened, no account is
        used and no money moves.
      </StatusBanner>
      <form action="/checkout/return" method="get">
        <input type="hidden" name="ref" value={view.order_ref} />
        <div className="field">
          <label htmlFor="scenario">What should the pretend payment do?</label>
          <select id="scenario" name="scenario" defaultValue="happy">
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="actions">
          <button className="btn btn-primary" type="submit">
            Approve payment (dry run)
          </button>
          <Link className="btn" href={`/orders/${encodeURIComponent(view.order_ref)}`}>
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
