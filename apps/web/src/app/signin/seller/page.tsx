import type { Metadata } from 'next';
import Link from 'next/link';
import {
  SELLER_SIGNIN_APPLY_LEAD,
  SELLER_SIGNIN_APPLY_LINK,
  SELLER_SIGNIN_LEDE,
  SELLER_SIGNIN_TITLE,
} from '../../../lib/account-copy';
import { safeNext } from '../../../lib/next-path';
import { SellerSignInForm } from './SellerSignInForm';
import '../../auth.css';

export const metadata: Metadata = { title: SELLER_SIGNIN_TITLE, referrer: 'no-referrer' };

// ID-ACCOUNTS: publisher sign in. It posts to the existing /api/session with a publisher persona.
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
      <SellerSignInForm next={next === '/' ? '/publisher' : next} />
      <p className="auth-links">
        <span>{SELLER_SIGNIN_APPLY_LEAD}</span>
        <Link className="auth-link" href="/apply">
          {SELLER_SIGNIN_APPLY_LINK}
        </Link>
      </p>
    </div>
  );
}
