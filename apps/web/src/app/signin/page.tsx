import type { Metadata } from 'next';
import Link from 'next/link';
import { SIGNIN_PRIVACY_END, SIGNIN_PRIVACY_LEAD, SIGNIN_PRIVACY_LINK } from '../../lib/legal-copy';
import { safeNext } from '../../lib/next-path';
import { SignInForm } from './SignInForm';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  return (
    <>
      <h1>Sign in</h1>
      <p className="lede">
        This is a test build. Pick a test persona and enter the demo passcode. Operators also enter
        their name and the code from their authenticator app.
      </p>
      <p className="muted" data-testid="signin-privacy">
        {SIGNIN_PRIVACY_LEAD}
        <Link href="/legal/privacy">{SIGNIN_PRIVACY_LINK}</Link>
        {SIGNIN_PRIVACY_END}
      </p>
      <SignInForm next={safeNext(q['next'])} />
    </>
  );
}
