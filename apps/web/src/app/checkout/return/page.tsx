import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { ErrorState } from '../../../ui/ErrorState';

export const metadata: Metadata = { title: 'Returning from payment' };

const SCENARIO = /^[a-z0-9_]{1,60}$/;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

// The buyer's return is a trigger, never evidence: onBuyerReturn reads the order back itself and
// uses the stored provider order id, not anything in this URL (P6).
export default async function CheckoutReturn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const ref = one(q['ref']);
  if (ref === undefined || ref === '') notFound();
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect('/signin');
  const a = await app();
  const sc = one(q['scenario']);
  const scenario = a.environment === 'dryrun' && sc !== undefined && SCENARIO.test(sc) ? sc : null;
  // Dry run only: this page stands in for PayPal's own approval step, so reaching it with a chosen
  // scenario is the pretend approval. In sandbox mode PayPal does that, and a scenario is ignored.
  if (scenario !== null) await a.engine.dryRunApprove({ order_ref: ref, actor, scenario });
  const r = await a.engine.payments.onBuyerReturn({ order_ref: ref, actor, scenario });
  if (r.ok) redirect(`/orders/${encodeURIComponent(ref)}`);
  if (r.error.code === 'not_found') notFound();
  if (r.error.code === 'payments_paused')
    return (
      <>
        <h1>Checkout is paused</h1>
        <ErrorState title="Nothing was charged">
          Payments are switched off for now. Your order is kept; try again later.
        </ErrorState>
        <p>
          <Link className="btn" href={`/orders/${encodeURIComponent(ref)}`}>
            Back to your order
          </Link>
        </p>
      </>
    );
  // Frozen, not approved, content unavailable: the order page says where the order stands.
  redirect(`/orders/${encodeURIComponent(ref)}`);
}
