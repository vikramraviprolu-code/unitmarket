import type { Metadata } from 'next';
import Link from 'next/link';
import { LINK_APPLY, SIGNIN_APPLY_LEAD } from '../../lib/apply-copy';
import { SIGNIN_PRIVACY_END, SIGNIN_PRIVACY_LEAD, SIGNIN_PRIVACY_LINK } from '../../lib/legal-copy';
import { safeNext } from '../../lib/next-path';
import {
  SIGNIN_ROLES_TITLE,
  SIGNIN_ROLE_LINKS,
  SIGNIN_TESTERS_TITLE,
} from '../../lib/account-copy';
import { SignInForm } from './SignInForm';
import '../auth.css';

export const metadata: Metadata = { title: 'Sign in' };

// The role pages take the same safe next path, so a person sent here from a closed page lands back on it.
const nextHref = (href: string, next: string | string[] | undefined): string => {
  const n = safeNext(next);
  return n === '/' ? href : `${href}?next=${encodeURIComponent(n)}`;
};

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  return (
    <>
      <h1>Sign in</h1>
      <section aria-labelledby="signin-roles">
        <h2 id="signin-roles">{SIGNIN_ROLES_TITLE}</h2>
        <ul className="auth-roles">
          {SIGNIN_ROLE_LINKS.map((l) => (
            <li key={l.id}>
              <Link className="btn btn-primary" href={nextHref(l.href, q['next'])}>
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section className="auth-testers" aria-labelledby="signin-testers">
        <h2 id="signin-testers">{SIGNIN_TESTERS_TITLE}</h2>
        <p className="lede">
          This is a test build. Pick a test persona and enter the demo passcode. Operators also
          enter their name and the code from their authenticator app.
        </p>
        <p className="muted" data-testid="signin-privacy">
          {SIGNIN_PRIVACY_LEAD}
          <Link href="/legal/privacy">{SIGNIN_PRIVACY_LINK}</Link>
          {SIGNIN_PRIVACY_END}
        </p>
        <SignInForm next={safeNext(q['next'])} />
        <p className="muted" data-testid="signin-apply">
          {SIGNIN_APPLY_LEAD} <Link href="/apply">{LINK_APPLY}</Link>
        </p>
      </section>
    </>
  );
}
