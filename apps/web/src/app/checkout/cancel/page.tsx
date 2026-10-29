import Link from 'next/link';
import type { Metadata } from 'next';
import { cancelView } from '../../../lib/cancel-view';
import { CANCEL_BACK_LINK, CANCEL_HEADING } from '../../../lib/composite-copy';

export const metadata: Metadata = { title: 'Payment not approved' };

// PayPal's cancel URL points here with `?ref=<order ref>` (domain/payments checkout.ts). The page makes
// no API call, opens no database and changes nothing. The ref is shape-checked and only put in a link
// to the return page (lib/cancel-view.ts); that page decides what the buyer may see, behind sign-in.
// Without a valid ref there is no link and no promise about the order.
export default async function CheckoutCancel({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const view = cancelView(q['ref']);
  return (
    <>
      <h1>{CANCEL_HEADING}</h1>
      <p data-testid="cancel-body">{view.body}</p>
      {view.window_line === null ? null : <p data-testid="cancel-window">{view.window_line}</p>}
      <div className="actions">
        {view.back_href === null ? null : (
          // A plain anchor on purpose: /checkout/return acts only on a full page navigation
          // (return-guard.ts); a client-side Link would make it show its confirm button first.
          <a className="btn btn-primary" data-testid="cancel-back" href={view.back_href}>
            {CANCEL_BACK_LINK}
          </a>
        )}
        <Link className="btn" href="/library">
          My library
        </Link>
      </div>
    </>
  );
}
