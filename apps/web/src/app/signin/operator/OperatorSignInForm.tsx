'use client';
import { useState } from 'react';
import { postJson, rememberCsrf } from '../../../lib/client-api';
import {
  BUYER_SIGNIN_BUSY,
  BUYER_SIGNIN_ERROR_TITLE,
  BUYER_SIGNIN_SUBMIT,
  OPERATOR_CODE_HINT,
  OPERATOR_CODE_LABEL,
  OPERATOR_NAME_LABEL,
  OPERATOR_PASSCODE_LABEL,
  OPERATOR_SIGNIN_FAILED,
  SIGNIN_TOO_MANY,
} from '../../../lib/account-copy';
import { safeNext } from '../../../lib/next-path';
import { ErrorState } from '../../../ui/ErrorState';

// ID-ACCOUNTS: operator sign in. Name and code are sent only when typed (leaving them empty gives the
// look-and-stop session the existing route describes). Posts to /api/session with the operator persona; the
// passcode check, the authenticator code and the lockout are the ones already there.
export function OperatorSignInForm({ next }: { next: string }) {
  const [operator, setOperator] = useState('');
  const [passcode, setPasscode] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await postJson<{ csrf_token: string }>('/api/session', {
      persona: 'operator',
      passcode,
      ...(operator.trim() === '' ? {} : { operator: operator.trim() }),
      ...(code.trim() === '' ? {} : { code: code.trim() }),
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 429 ? SIGNIN_TOO_MANY : OPERATOR_SIGNIN_FAILED);
      return;
    }
    rememberCsrf(r.data.csrf_token);
    window.location.assign(safeNext(next));
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate data-testid="operator-signin-form">
      {error ? <ErrorState title={BUYER_SIGNIN_ERROR_TITLE}>{error}</ErrorState> : null}
      <div className="field">
        <label htmlFor="os-name">{OPERATOR_NAME_LABEL}</label>
        <input
          id="os-name"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={operator}
          onChange={(e) => setOperator(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="os-passcode">{OPERATOR_PASSCODE_LABEL}</label>
        <input
          id="os-passcode"
          type="password"
          autoComplete="current-password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="os-code">{OPERATOR_CODE_LABEL}</label>
        <p className="hint" id="os-code-hint">
          {OPERATOR_CODE_HINT}
        </p>
        <input
          id="os-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          spellCheck={false}
          aria-describedby="os-code-hint"
          value={code}
          onChange={(e) => setCode(e.target.value)}
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
