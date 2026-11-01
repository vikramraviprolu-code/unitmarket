'use client';
import { useState } from 'react';
import { postJson, rememberCsrf } from '../../../lib/client-api';
import {
  BUYER_SIGNIN_BUSY,
  BUYER_SIGNIN_ERROR_TITLE,
  BUYER_SIGNIN_SUBMIT,
  SELLER_SIGNIN_FAILED,
  SELLER_SIGNIN_PUBLISHER,
  SIGNIN_TOO_MANY,
} from '../../../lib/account-copy';
import {
  PUBLISHER_PASSCODE_HINT,
  PUBLISHER_PASSCODE_LABEL,
  PUBLISHER_PERSONAS,
} from '../../../lib/publisher-copy';
import { safeNext } from '../../../lib/next-path';
import { ErrorState } from '../../../ui/ErrorState';

// ID-ACCOUNTS: publisher sign in. The owners set a publisher up after approving an application; this posts to
// the existing /api/session with a publisher persona and the publisher passcode, which that route checks.
export function SellerSignInForm({ next }: { next: string }) {
  const [persona, setPersona] = useState<string>(PUBLISHER_PERSONAS[0].id);
  const [passcode, setPasscode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await postJson<{ csrf_token: string }>('/api/session', { persona, passcode });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 429 ? SIGNIN_TOO_MANY : SELLER_SIGNIN_FAILED);
      return;
    }
    rememberCsrf(r.data.csrf_token);
    window.location.assign(safeNext(next));
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate data-testid="seller-signin-form">
      {error ? <ErrorState title={BUYER_SIGNIN_ERROR_TITLE}>{error}</ErrorState> : null}
      <div className="field">
        <label htmlFor="ss-publisher">{SELLER_SIGNIN_PUBLISHER}</label>
        <select id="ss-publisher" value={persona} onChange={(e) => setPersona(e.target.value)}>
          {PUBLISHER_PERSONAS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ss-passcode">{PUBLISHER_PASSCODE_LABEL}</label>
        <p className="hint" id="ss-passcode-hint">
          {PUBLISHER_PASSCODE_HINT}
        </p>
        <input
          id="ss-passcode"
          type="password"
          autoComplete="current-password"
          aria-describedby="ss-passcode-hint"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
        />
      </div>
      <p>
        <button className="btn btn-primary" type="submit" disabled={busy || passcode === ''}>
          {busy ? BUYER_SIGNIN_BUSY : BUYER_SIGNIN_SUBMIT}
        </button>
      </p>
    </form>
  );
}
