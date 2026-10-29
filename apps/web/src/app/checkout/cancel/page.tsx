import Link from 'next/link';
import type { Metadata } from 'next';
import { CANCEL_BODY, CANCEL_HEADING } from '../../../lib/composite-copy';

export const metadata: Metadata = { title: 'Payment not approved' };

// PayPal's cancel URL points here (domain/payments checkout.ts). Static on purpose: it reads no order,
// takes no id from the URL and calls nothing. There is no cancel API; the order page says where the
// order stands.
export default function CheckoutCancel() {
  return (
    <>
      <h1>{CANCEL_HEADING}</h1>
      <p data-testid="cancel-body">{CANCEL_BODY}</p>
      <p>
        <Link className="btn" href="/library">
          My library
        </Link>
      </p>
    </>
  );
}
