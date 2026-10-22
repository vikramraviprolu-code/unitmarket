'use client';
import { useState } from 'react';
import { postJson, rememberCsrf } from '../../lib/client-api';
import { ErrorState } from '../../ui/ErrorState';

const PERSONAS = [
  { id: 'buyer-a', label: 'Buyer A' },
  { id: 'buyer-b', label: 'Buyer B' },
  { id: 'publisher', label: 'Publisher' },
  { id: 'operator', label: 'Operator (read only)' },
];

export function SignInForm({ next }: { next: string }) {
  const [persona, setPersona] = useState('buyer-a');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await postJson<{ csrf_token: string }>('/api/session', { persona, passcode });
    setBusy(false);
    if (!r.ok) {
      setError(
        r.status === 429
          ? 'Too many tries. Wait a few minutes and try again.'
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
      <button className="btn btn-primary" type="submit" disabled={busy || passcode === ''}>
        {busy ? 'Signing in' : 'Sign in'}
      </button>
    </form>
  );
}
