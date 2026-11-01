import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { app } from '../../server/access';
import { currentActor } from '../../server/session';
import {
  ACCOUNT_COUNTRY_LABEL,
  ACCOUNT_NO_PASSWORD,
  ACCOUNT_SIGNED_IN_AS,
  ACCOUNT_TITLE,
  ACCOUNT_USERNAME_LABEL,
} from '../../lib/account-copy';
import { AccountForms } from './AccountForms';
import '../auth.css';

export const metadata: Metadata = { title: ACCOUNT_TITLE };

// ID-ACCOUNTS: the account page of a buyer. Anyone else is sent to buyer sign in. A test persona (a shared
// sign in with no password) is told so. The view is the actor's own row; nothing comes from the URL.
export default async function AccountPage() {
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect('/signin/buyer?next=/account');
  const view = await (await app()).engine.accounts.view(actor);
  return (
    <div className="auth-wrap" data-testid="account-page">
      <header className="auth-head">
        <h1>{ACCOUNT_TITLE}</h1>
        {view === null ? (
          <p className="lede" data-testid="account-persona">
            {ACCOUNT_NO_PASSWORD}
          </p>
        ) : (
          <p className="lede" data-testid="account-who">
            {ACCOUNT_SIGNED_IN_AS} {view.display_name}. {ACCOUNT_USERNAME_LABEL}: {view.username}.{' '}
            {ACCOUNT_COUNTRY_LABEL}: {view.country}.
          </p>
        )}
      </header>
      {view === null ? null : <AccountForms />}
    </div>
  );
}
