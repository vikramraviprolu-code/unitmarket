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
  const r = await a.engine.payments.onBuyerReturn({ order_ref: ref, actor, scenario });
  if (r.ok) redirect(`/orders/${encodeURIComponent(ref)}`);
  if (r.error.code === 'not_found') notFound();
  if (r.error.code === 'payments_not_wired')
    return (
      <>
        <h1>Checkout is not available yet</h1>
        <ErrorState title="Nothing was charged">
          This build has no payment step wired in. Go back to your library or the offer.
        </ErrorState>
        <p>
          <Link className="btn" href="/library">
            My library
          </Link>
        </p>
      </>
    );
  redirect(`/orders/${encodeURIComponent(ref)}`);
}
