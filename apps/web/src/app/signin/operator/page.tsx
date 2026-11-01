import type { Metadata } from 'next';
import { OPERATOR_SIGNIN_LEDE, OPERATOR_SIGNIN_TITLE } from '../../../lib/account-copy';
import { safeNext } from '../../../lib/next-path';
import { OperatorSignInForm } from './OperatorSignInForm';
import '../../auth.css';

export const metadata: Metadata = { title: OPERATOR_SIGNIN_TITLE, referrer: 'no-referrer' };

// ID-ACCOUNTS: operator sign in: passcode, name and authenticator code. It posts to the existing /api/session
// with the operator persona; the lockout and the second factor are the ones already there.
export default async function OperatorSignIn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const next = safeNext(q['next']);
  return (
    <div className="auth-wrap" data-testid="operator-signin-page">
      <header className="auth-head">
        <h1>{OPERATOR_SIGNIN_TITLE}</h1>
        <p className="lede">{OPERATOR_SIGNIN_LEDE}</p>
      </header>
      <OperatorSignInForm next={next === '/' ? '/ops' : next} />
    </div>
  );
}
