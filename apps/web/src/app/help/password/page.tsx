import type { Metadata } from 'next';
import Link from 'next/link';
import {
  HELP_PASSWORD_BACK,
  HELP_PASSWORD_LEDE,
  HELP_PASSWORD_STEPS,
  HELP_PASSWORD_TITLE,
} from '../../../lib/account-copy';
import '../../auth.css';

export const metadata: Metadata = { title: HELP_PASSWORD_TITLE };

// ID-ACCOUNTS: a lost password is reset by the operator at the terminal. No email, no reset link.
export default function PasswordHelp() {
  return (
    <div className="auth-wrap" data-testid="help-password">
      <header className="auth-head">
        <h1>{HELP_PASSWORD_TITLE}</h1>
        <p className="lede">{HELP_PASSWORD_LEDE}</p>
      </header>
      <section className="auth-card">
        <ol className="auth-steps">
          {HELP_PASSWORD_STEPS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p>
          <Link className="btn" href="/signin/buyer">
            {HELP_PASSWORD_BACK}
          </Link>
        </p>
      </section>
    </div>
  );
}
