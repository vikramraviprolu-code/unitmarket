'use client';
import { useState } from 'react';
import { postJson, rememberCsrf } from '../../../lib/client-api';
import { BUYER_SIGNIN_ERROR_TITLE, SIGNIN_TOO_MANY } from '../../../lib/account-copy';
import {
  ACCOUNT_SIGNIN_BUSY,
  ACCOUNT_SIGNIN_FAILED,
  ACCOUNT_SIGNIN_PASSWORD,
  ACCOUNT_SIGNIN_SUBMIT,
  ACCOUNT_SIGNIN_USERNAME,
} from '../../../lib/publisher-accounts-copy';
import { safeNext } from '../../../lib/next-path';
import { ErrorState } from '../../../ui/ErrorState';
import { PasswordField, ShowPasswordButton } from '../../../ui/PasswordField';

// POB-P1: publisher sign in with the username and password chosen at the claim. It posts to /api/session with a
// username and a password instead of a persona. Every refusal reads the same, except the rate limit.
export function AccountSignInForm({ next }: { next: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await postJson<{ csrf_token: string }>('/api/session', {
      username: username.trim().toLowerCase(),
      password,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 429 ? SIGNIN_TOO_MANY : ACCOUNT_SIGNIN_FAILED);
      return;
    }
    rememberCsrf(r.data.csrf_token);
    window.location.assign(safeNext(next));
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate data-testid="seller-account-form">
      {error ? <ErrorState title={BUYER_SIGNIN_ERROR_TITLE}>{error}</ErrorState> : null}
      <div className="field">
        <label htmlFor="sa-username">{ACCOUNT_SIGNIN_USERNAME}</label>
        <input
          id="sa-username"
          name="username"
          type="text"
          maxLength={30}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>
      <PasswordField
        id="sa-password"
        label={ACCOUNT_SIGNIN_PASSWORD}
        value={password}
        onChange={setPassword}
        shown={shown}
        autoComplete="current-password"
      />
      <ShowPasswordButton shown={shown} onToggle={() => setShown(!shown)} controls="sa-password" />
      <p>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={busy || username.trim() === '' || password === ''}
        >
          {busy ? ACCOUNT_SIGNIN_BUSY : ACCOUNT_SIGNIN_SUBMIT}
        </button>
      </p>
    </form>
  );
}
