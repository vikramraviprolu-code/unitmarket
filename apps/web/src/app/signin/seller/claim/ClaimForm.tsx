'use client';
import { useState } from 'react';
import { postJson, rememberCsrf } from '../../../../lib/client-api';
import {
  CLAIM_BUSY,
  CLAIM_ERROR_TITLE,
  CLAIM_FIELD_CODE,
  CLAIM_FIELD_PASSWORD,
  CLAIM_FIELD_USERNAME,
  CLAIM_HINT_CODE,
  CLAIM_HINT_PASSWORD,
  CLAIM_HINT_USERNAME,
  CLAIM_SUBMIT,
} from '../../../../lib/publisher-accounts-copy';
import { ErrorState } from '../../../../ui/ErrorState';
import { PasswordField, ShowPasswordButton } from '../../../../ui/PasswordField';

// POB-P1: claim a publisher account. The route checks everything again; the form only carries what was typed.
// The route's own sentence is shown (it already reads in words), and the password is sent exactly as typed.
export function ClaimForm() {
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await postJson<{ csrf_token: string }>('/api/publisher-accounts/claim', {
      code: code.trim(),
      username: username.trim().toLowerCase(),
      password,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    rememberCsrf(r.data.csrf_token);
    window.location.assign('/publisher');
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate data-testid="seller-claim-form">
      {error ? <ErrorState title={CLAIM_ERROR_TITLE}>{error}</ErrorState> : null}
      <div className="field">
        <label htmlFor="cl-code">{CLAIM_FIELD_CODE}</label>
        <p className="hint" id="cl-code-hint">
          {CLAIM_HINT_CODE}
        </p>
        <input
          id="cl-code"
          name="code"
          type="text"
          maxLength={20}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-describedby="cl-code-hint"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="cl-username">{CLAIM_FIELD_USERNAME}</label>
        <p className="hint" id="cl-username-hint">
          {CLAIM_HINT_USERNAME}
        </p>
        <input
          id="cl-username"
          name="username"
          type="text"
          maxLength={30}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby="cl-username-hint"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>
      <PasswordField
        id="cl-password"
        label={CLAIM_FIELD_PASSWORD}
        hint={CLAIM_HINT_PASSWORD}
        value={password}
        onChange={setPassword}
        shown={shown}
        autoComplete="new-password"
      />
      <ShowPasswordButton shown={shown} onToggle={() => setShown(!shown)} controls="cl-password" />
      <p>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={busy || code.trim() === '' || username.trim() === '' || password === ''}
        >
          {busy ? CLAIM_BUSY : CLAIM_SUBMIT}
        </button>
      </p>
    </form>
  );
}
