import type { Metadata } from 'next';
import { SIGNUP_LEDE, SIGNUP_TITLE } from '../../lib/account-copy';
import { safeNext } from '../../lib/next-path';
import { SignUpForm } from './SignUpForm';
import '../auth.css';

export const metadata: Metadata = { title: SIGNUP_TITLE, referrer: 'no-referrer' };

// ID-ACCOUNTS: create a buyer account. Public, reads nothing from the database, sets no cookie itself.
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const next = safeNext(q['next']);
  return (
    <div className="auth-wrap" data-testid="signup-page">
      <header className="auth-head">
        <h1>{SIGNUP_TITLE}</h1>
        <p className="lede">{SIGNUP_LEDE}</p>
      </header>
      <SignUpForm next={next === '/' ? '/discover' : next} />
    </div>
  );
}
