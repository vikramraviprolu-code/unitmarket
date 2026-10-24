'use client';
import { useState } from 'react';
import { postJson, rememberCsrf } from '../../lib/client-api';
import { ErrorState } from '../../ui/ErrorState';

const PERSONAS = [
  { id: 'buyer-a', label: 'Buyer A' },
  { id: 'buyer-b', label: 'Buyer B' },
  { id: 'publisher', label: 'Publisher' },
  { id: 'operator', label: 'Operator' },
];

export function SignInForm({ next }: { next: string }) {
  const [persona, setPersona] = useState('buyer-a');
  const [passcode, setPasscode] = useState('');
  const [operator, setOperator] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Name and code are sent for the operator only, and only when typed.
    const second =
      persona === 'operator'
        ? {
            ...(operator.trim() === '' ? {} : { operator: operator.trim() }),
            ...(code.trim() === '' ? {} : { code: code.trim() }),
          }
        : {};
    const r = await postJson<{ csrf_token: string }>('/api/session', {
      persona,
      passcode,
      ...second,
    });
    setBusy(false);
    if (!r.ok) {
      setError(
        r.status === 429
          ? 'Too many tries. Wait a few minutes and try again.'
          : persona === 'operator'
            ? 'That did not work. Check the passcode, your name and the current code, then try again.'
            : 'That passcode did not work. Check it and try again.',
      );
      return;
    }
    rememberCsrf(r.data.csrf_token);
    window.location.assign(next);
  }
  return (
    <form onSubmit={submit} noValidate>
      {error ? <ErrorState title="Could not sign in">{error}</ErrorState> : null}
      <div className="field">
        <label htmlFor="persona">Who are you testing as?</label>
        <select id="persona" value={persona} onChange={(e) => setPersona(e.target.value)}>
          {PERSONAS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="passcode">Demo passcode</label>
        <p className="hint" id="passcode-hint">
          The passcode your team lead gave you. You can paste it.
        </p>
        <input
          id="passcode"
          type="password"
          autoComplete="current-password"
          aria-describedby="passcode-hint"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
        />
      </div>
      {persona === 'operator' ? (
        <>
          <div className="field">
            <label htmlFor="operator">Operator name</label>
            <input
              id="operator"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="code">Authenticator code</label>
            <p className="hint" id="code-hint">
              The 6 digits from your authenticator app. Leave the name and code empty to look and
              stop PayPal calls only: refunds and switching anything on need the code.
            </p>
            <input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              spellCheck={false}
              aria-describedby="code-hint"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
        </>
      ) : null}
      <button className="btn btn-primary" type="submit" disabled={busy || passcode === ''}>
        {busy ? 'Signing in' : 'Sign in'}
      </button>
    </form>
  );
}
