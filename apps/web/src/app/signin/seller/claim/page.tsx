import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CLAIM_HAVE_ACCOUNT,
  CLAIM_LEDE,
  CLAIM_SIGN_IN_LINK,
  CLAIM_TITLE,
} from '../../../../lib/publisher-accounts-copy';
import { ClaimForm } from './ClaimForm';
import '../../../auth.css';

export const metadata: Metadata = { title: CLAIM_TITLE, referrer: 'no-referrer' };

// POB-P1 (J3): a new publisher claims their account with the one time invite code an operator gave them. The
// code is typed by the person; it is never put in the address, so it does not reach a log or a referrer.
export default function ClaimAccount() {
  return (
    <div className="auth-wrap" data-testid="seller-claim-page">
      <header className="auth-head">
        <h1>{CLAIM_TITLE}</h1>
        <p className="lede">{CLAIM_LEDE}</p>
      </header>
      <ClaimForm />
      <p className="auth-links">
        <span>{CLAIM_HAVE_ACCOUNT}</span>
        <Link className="auth-link" href="/signin/seller">
          {CLAIM_SIGN_IN_LINK}
        </Link>
      </p>
    </div>
  );
}
