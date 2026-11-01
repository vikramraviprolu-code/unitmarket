'use client';
import { useState } from 'react';
import { postJson, rememberCsrf } from '../../../lib/client-api';
import {
  BUYER_SIGNIN_BUSY,
  BUYER_SIGNIN_ERROR_TITLE,
  BUYER_SIGNIN_FAILED,
  BUYER_SIGNIN_PASSWORD,
  BUYER_SIGNIN_SUBMIT,
  BUYER_SIGNIN_USERNAME,
  SIGNIN_TOO_MANY,
} from '../../../lib/account-copy';
import { safeNext } from '../../../lib/next-path';
import { ErrorState } from '../../../ui/ErrorState';
import { PasswordField, ShowPasswordButton } from '../../../ui/PasswordField';

// ID-ACCOUNTS: buyer sign in. Every refusal reads the same (an unknown name, a wrong password and a locked
// account), except the rate limit, which says to wait. The password is sent exactly as typed.
export function BuyerSignInForm({ next }: { next: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const named = username.trim() !== '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await postJson<{ csrf_token: string }>('/api/accounts/login', {
      username: username.trim().toLowerCase(),
      password,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 429 ? SIGNIN_TOO_MANY : BUYER_SIGNIN_FAILED);
      return;
    }
    rememberCsrf(r.data.csrf_token);
    window.location.assign(safeNext(next));
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate data-testid="buyer-signin-form">
      {error ? <ErrorState title={BUYER_SIGNIN_ERROR_TITLE}>{error}</ErrorState> : null}
      <div className="field">
        <label htmlFor="bs-username">{BUYER_SIGNIN_USERNAME}</label>
        <input
          id="bs-username"
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
        id="bs-password"
        label={BUYER_SIGNIN_PASSWORD}
        value={password}
        onChange={setPassword}
        shown={shown}
        autoComplete="current-password"
      />
      <ShowPasswordButton shown={shown} onToggle={() => setShown(!shown)} controls="bs-password" />
      <p>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={busy || !named || password === ''}
        >
          {busy ? BUYER_SIGNIN_BUSY : BUYER_SIGNIN_SUBMIT}
        </button>
      </p>
    </form>
  );
}
