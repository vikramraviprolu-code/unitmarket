import type { Metadata } from 'next';
import Link from 'next/link';
import {
  BUYER_SIGNIN_CREATE,
  BUYER_SIGNIN_FORGOT,
  BUYER_SIGNIN_LEDE,
  BUYER_SIGNIN_TITLE,
} from '../../../lib/account-copy';
import {
  SIGNIN_PRIVACY_END,
  SIGNIN_PRIVACY_LEAD,
  SIGNIN_PRIVACY_LINK,
} from '../../../lib/legal-copy';
import { safeNext } from '../../../lib/next-path';
import { BuyerSignInForm } from './BuyerSignInForm';
import '../../auth.css';

export const metadata: Metadata = { title: BUYER_SIGNIN_TITLE, referrer: 'no-referrer' };

// ID-ACCOUNTS: buyer sign in with a username and a password.
export default async function BuyerSignIn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const next = safeNext(q['next']);
  return (
    <div className="auth-wrap" data-testid="buyer-signin-page">
      <header className="auth-head">
        <h1>{BUYER_SIGNIN_TITLE}</h1>
        <p className="lede">{BUYER_SIGNIN_LEDE}</p>
      </header>
      <BuyerSignInForm next={next === '/' ? '/library' : next} />
      <p className="auth-links">
        <Link className="auth-link" href="/help/password">
          {BUYER_SIGNIN_FORGOT}
        </Link>
        <Link
          className="auth-link"
          href={next === '/' ? '/signup' : `/signup?next=${encodeURIComponent(next)}`}
        >
          {BUYER_SIGNIN_CREATE}
        </Link>
      </p>
      <p className="muted" data-testid="signin-privacy">
        {SIGNIN_PRIVACY_LEAD}
        <Link href="/legal/privacy">{SIGNIN_PRIVACY_LINK}</Link>
        {SIGNIN_PRIVACY_END}
      </p>
    </div>
  );
}
