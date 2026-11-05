import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { isBuyerNavigation } from '../../../server/return-guard';
import { currentActor } from '../../../server/session';
import { ErrorState } from '../../../ui/ErrorState';
import { stepButton, stepDeadline, stepHeading } from '../../../lib/composite-copy';

export const metadata: Metadata = { title: 'Returning from payment' };

const SCENARIO = /^[a-z0-9_]{1,60}$/;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

// The buyer's return is a trigger, never evidence: onBuyerReturn reads the order back itself and
// uses the stored provider order id, not anything in this URL (P6). Only a page navigation starts
// it (return-guard.ts); anything else is shown a button (a GET form, itself a page navigation).
export default async function CheckoutReturn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const ref = one(q['ref']);
  if (ref === undefined || ref === '') notFound();
  const sc = one(q['scenario']);
  const po = one(q['po']);
  const h = await headers();
  if (isBuyerNavigation((name) => h.get(name))) return finishReturn(ref, sc, po);
  // Not a page navigation (an image, a frame, a fetch, a prefetch, or a client without Sec-Fetch
  // headers): nothing starts. The button is a GET form, which the browser sends as a page
  // navigation, so a real buyer is one click from the same place. (Server actions are not used:
  // check:routes bars them.)
  return (
    <>
      <h1>Confirm your return</h1>
      <p>Press the button to go on to your order. Nothing is charged by this page itself.</p>
      <form action="/checkout/return" method="get">
        <input type="hidden" name="ref" value={ref} />
        {sc === undefined ? null : <input type="hidden" name="scenario" value={sc} />}
        {po === undefined ? null : <input type="hidden" name="po" value={po} />}
        <button className="btn btn-primary" type="submit">
          Continue to your order
        </button>
      </form>
    </>
  );
}

async function finishReturn(ref: string, sc: string | undefined, po: string | undefined) {
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect('/signin');
  const a = await app();
  const scenario = a.environment === 'dryrun' && sc !== undefined && SCENARIO.test(sc) ? sc : null;
  // Dry run only: this page stands in for PayPal's own approval step, so reaching it with a chosen
  // scenario is the pretend approval. In sandbox mode PayPal does that, and a scenario is ignored.
  // `po` names which PayPal order of a pack this pretend approval is for (1..9). A pack keeps each
  // PayPal order's own scenario, so the return then carries none.
  const position = po !== undefined && /^[1-9]$/.test(po) ? Number(po) : undefined;
  // INT-TC1: this page writes (the return is the trigger), so it opens the buyer's journal context itself.
  const r = await a.engine.asPageActor(actor, async () => {
    if (scenario !== null)
      await a.engine.dryRunApprove({
        order_ref: ref,
        actor,
        scenario,
        ...(position === undefined ? {} : { position }),
      });
    return a.engine.payments.onBuyerReturn({
      order_ref: ref,
      actor,
      scenario: position === undefined ? scenario : null,
    });
  });
  if (r.ok && r.value.next !== null) {
    // OQ-5: one PayPal order of the pack is still waiting for the buyer. No automatic redirect: the
    // buyer presses the one button. The link is the stored one for that PayPal order; on the dry run
    // the dry-run page stands in for PayPal's own page.
    const next = r.value.next;
    const target =
      a.environment === 'dryrun'
        ? `/checkout/dry-run/${encodeURIComponent(ref)}`
        : next.approve_url;
    return (
      <>
        <h1 data-testid="step-heading">{stepHeading(next.step, next.of, next.publisher)}</h1>
        <p data-testid="step-deadline">{stepDeadline(a.engine.packWindowMinutes())}</p>
        <p>
          <a className="btn btn-primary" href={target}>
            {stepButton(next.step, next.of)}
          </a>
        </p>
        <p>
          <Link href={`/orders/${encodeURIComponent(ref)}`}>See where your order stands</Link>
        </p>
      </>
    );
  }
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
