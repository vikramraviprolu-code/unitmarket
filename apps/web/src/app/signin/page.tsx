import type { Metadata } from 'next';
import { SignInForm } from './SignInForm';

export const metadata: Metadata = { title: 'Sign in' };

function safeNext(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v;
  return s !== undefined && /^\/(?![/\\])[A-Za-z0-9._~\-/[\]?=&%]*$/.test(s) ? s : '/';
}

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  return (
    <>
      <h1>Sign in</h1>
      <p className="lede">This is a test build. Pick a test persona and enter the demo passcode.</p>
      <SignInForm next={safeNext(q['next'])} />
    </>
  );
}
