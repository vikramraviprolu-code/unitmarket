import type { Metadata } from 'next';
import Link from 'next/link';
import {
  SELLER_SIGNIN_APPLY_LEAD,
  SELLER_SIGNIN_APPLY_LINK,
  SELLER_SIGNIN_LEDE,
  SELLER_SIGNIN_TITLE,
} from '../../../lib/account-copy';
import { safeNext } from '../../../lib/next-path';
import {
  ACCOUNT_SIGNIN_CLAIM_LEAD,
  ACCOUNT_SIGNIN_CLAIM_LINK,
  ACCOUNT_SIGNIN_HEADING,
  ACCOUNT_SIGNIN_LEDE,
  DEMO_SIGNIN_HEADING,
} from '../../../lib/publisher-accounts-copy';
import { AccountSignInForm } from './AccountSignInForm';
import { SellerSignInForm } from './SellerSignInForm';
import '../../auth.css';

export const metadata: Metadata = { title: SELLER_SIGNIN_TITLE, referrer: 'no-referrer' };

// ID-ACCOUNTS: publisher sign in. POB-P1: first the publisher's own account (username and password, claimed with
// an invite code), then the test personas for judges. Both post to /api/session.
export default async function SellerSignIn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const next = safeNext(q['next']);
  return (
    <div className="auth-wrap" data-testid="seller-signin-page">
      <header className="auth-head">
        <h1>{SELLER_SIGNIN_TITLE}</h1>
        <p className="lede">{SELLER_SIGNIN_LEDE}</p>
      </header>
      <section aria-labelledby="seller-account-heading">
        <h2 id="seller-account-heading">{ACCOUNT_SIGNIN_HEADING}</h2>
        <p className="lede">{ACCOUNT_SIGNIN_LEDE}</p>
        <AccountSignInForm next={next === '/' ? '/publisher' : next} />
        <p className="auth-links">
          <span>{ACCOUNT_SIGNIN_CLAIM_LEAD}</span>
          <Link className="auth-link" href="/signin/seller/claim">
            {ACCOUNT_SIGNIN_CLAIM_LINK}
          </Link>
        </p>
      </section>
      <section aria-labelledby="seller-demo-heading">
        <h2 id="seller-demo-heading">{DEMO_SIGNIN_HEADING}</h2>
        <SellerSignInForm next={next === '/' ? '/publisher' : next} />
      </section>
      <p className="auth-links">
        <span>{SELLER_SIGNIN_APPLY_LEAD}</span>
        <Link className="auth-link" href="/apply">
          {SELLER_SIGNIN_APPLY_LINK}
        </Link>
      </p>
    </div>
  );
}
