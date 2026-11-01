'use client';
import { useState } from 'react';
import Link from 'next/link';
import { postJson, rememberCsrf } from '../../lib/client-api';
import {
  SIGNUP_ACCEPT_AND,
  SIGNUP_ACCEPT_END,
  SIGNUP_ACCEPT_LEAD,
  SIGNUP_ACCEPT_PRIVACY,
  SIGNUP_ACCEPT_TERMS,
  SIGNUP_BUSY,
  SIGNUP_ERROR_TITLE,
  SIGNUP_FIELD_COUNTRY,
  SIGNUP_FIELD_NAME,
  SIGNUP_FIELD_PASSWORD,
  SIGNUP_FIELD_REPEAT,
  SIGNUP_FIELD_USERNAME,
  SIGNUP_HAVE_ACCOUNT,
  SIGNUP_HINT_NAME,
  SIGNUP_HINT_USERNAME,
  SIGNUP_HONEYPOT,
  SIGNUP_MISMATCH,
  SIGNUP_NEW_TAB,
  SIGNUP_PASSWORD_RULES,
  SIGNUP_PASSWORD_RULES_TITLE,
  SIGNUP_SIGN_IN_LINK,
  SIGNUP_SUBMIT,
  SIGNUP_TERMS_MISSING,
  signupErrorText,
} from '../../lib/account-copy';
import { safeNext } from '../../lib/next-path';
import { ErrorState } from '../../ui/ErrorState';
import { PasswordField, ShowPasswordButton } from '../../ui/PasswordField';

// ID-ACCOUNTS: the signup form. It only carries what was typed; the route checks everything again. The
// password is sent exactly as typed (never trimmed), the username is saved in lower case, and the field
// named extra_k7q is the honeypot: hidden from people, and a filled one gets a success that stores nothing.
export function SignUpForm({ next }: { next: string }) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [country, setCountry] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [shown, setShown] = useState(false);
  const [accept, setAccept] = useState(false);
  const [trap, setTrap] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = [name, username, country].every((v) => v.trim() !== '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== repeat) {
      setError(SIGNUP_MISMATCH);
      return;
    }
    if (!accept) {
      setError(SIGNUP_TERMS_MISSING);
      return;
    }
    setBusy(true);
    const r = await postJson<{ csrf_token: string }>('/api/accounts', {
      display_name: name.trim(),
      username: username.trim().toLowerCase(),
      country: country.trim().toUpperCase(),
      password,
      accept_terms: true,
      extra_k7q: trap,
    });
    setBusy(false);
    if (!r.ok) {
      setError(
        r.code === 'weak_password' ? r.message : signupErrorText(r.status === 0 ? 'other' : r.code),
      );
      return;
    }
    rememberCsrf(r.data.csrf_token);
    window.location.assign(safeNext(next));
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate data-testid="signup-form">
      {error ? <ErrorState title={SIGNUP_ERROR_TITLE}>{error}</ErrorState> : null}
      <div className="field">
        <label htmlFor="su-name">{SIGNUP_FIELD_NAME}</label>
        <p className="hint" id="su-name-hint">
          {SIGNUP_HINT_NAME}
        </p>
        <input
          id="su-name"
          name="display_name"
          type="text"
          maxLength={60}
          autoComplete="name"
          aria-describedby="su-name-hint"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="su-username">{SIGNUP_FIELD_USERNAME}</label>
        <p className="hint" id="su-username-hint">
          {SIGNUP_HINT_USERNAME}
        </p>
        <input
          id="su-username"
          name="username"
          type="text"
          maxLength={30}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby="su-username-hint"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="su-country">{SIGNUP_FIELD_COUNTRY}</label>
        <input
          id="su-country"
          name="country"
          type="text"
          maxLength={2}
          autoCapitalize="characters"
          autoComplete="country"
          spellCheck={false}
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        />
      </div>
      <p className="auth-rules-title" id="su-rules-title">
        {SIGNUP_PASSWORD_RULES_TITLE}
      </p>
      <ul className="auth-rules" id="su-rules" aria-labelledby="su-rules-title">
        {SIGNUP_PASSWORD_RULES.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <PasswordField
        id="su-password"
        label={SIGNUP_FIELD_PASSWORD}
        value={password}
        onChange={setPassword}
        shown={shown}
        autoComplete="new-password"
        describedBy="su-rules"
      />
      <PasswordField
        id="su-repeat"
        label={SIGNUP_FIELD_REPEAT}
        value={repeat}
        onChange={setRepeat}
        shown={shown}
        autoComplete="new-password"
      />
      <ShowPasswordButton
        shown={shown}
        onToggle={() => setShown(!shown)}
        controls="su-password su-repeat"
      />
      <div className="auth-accept">
        <label className="check">
          <input
            id="su-accept"
            type="checkbox"
            required
            aria-describedby="su-accept-note"
            checked={accept}
            onChange={(e) => setAccept(e.target.checked)}
          />
          <span>
            {SIGNUP_ACCEPT_LEAD}
            <Link href="/legal/terms" target="_blank" rel="noopener">
              {SIGNUP_ACCEPT_TERMS}
            </Link>
            {SIGNUP_ACCEPT_AND}
            <Link href="/legal/privacy" target="_blank" rel="noopener">
              {SIGNUP_ACCEPT_PRIVACY}
            </Link>
            {SIGNUP_ACCEPT_END}
          </span>
        </label>
        <span className="visually-hidden" id="su-accept-note">
          {SIGNUP_NEW_TAB}
        </span>
      </div>
      <div className="auth-hp" aria-hidden="true">
        <label htmlFor="su-extra">{SIGNUP_HONEYPOT}</label>
        <input
          id="su-extra"
          name="extra_k7q"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          value={trap}
          onChange={(e) => setTrap(e.target.value)}
        />
      </div>
      <button
        className="btn btn-primary"
        type="submit"
        disabled={busy || !typed || password === ''}
      >
        {busy ? SIGNUP_BUSY : SIGNUP_SUBMIT}
      </button>
      <p className="auth-links">
        <span>{SIGNUP_HAVE_ACCOUNT}</span>
        <Link className="auth-link" href="/signin/buyer">
          {SIGNUP_SIGN_IN_LINK}
        </Link>
      </p>
    </form>
  );
}
