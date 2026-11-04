'use client';
import { useState } from 'react';
import { postJson } from '../../lib/client-api';
import {
  ACCOUNT_ALL_BUSY,
  ACCOUNT_ALL_BUTTON,
  ACCOUNT_ALL_FAILED,
  ACCOUNT_ALL_LEDE,
  ACCOUNT_ALL_TITLE,
  ACCOUNT_CHANGE,
  ACCOUNT_CHANGE_BUSY,
  ACCOUNT_CHANGED,
  ACCOUNT_ERROR_TITLE,
  ACCOUNT_FIELD_CURRENT,
  ACCOUNT_FIELD_NEW,
  ACCOUNT_FIELD_REPEAT,
  ACCOUNT_PASSWORD_TITLE,
  SIGNUP_MISMATCH,
  SIGNUP_PASSWORD_RULES,
  accountPasswordErrorText,
} from '../../lib/account-copy';
import {
  DISPLAY_CURRENCIES,
  DISPLAY_CURRENCY_FAILED,
  DISPLAY_CURRENCY_LABEL,
  DISPLAY_CURRENCY_LEDE,
  DISPLAY_CURRENCY_OPTION,
  DISPLAY_CURRENCY_SAVE,
  DISPLAY_CURRENCY_SAVED,
  DISPLAY_CURRENCY_SAVING,
  DISPLAY_CURRENCY_TITLE,
  autoOptionLabel,
  isDisplayCurrency,
} from '../../lib/buyer-price';
import { ErrorState } from '../../ui/ErrorState';
import { PasswordField, ShowPasswordButton } from '../../ui/PasswordField';

// ID-ACCOUNTS: change the password, and sign out on all devices. Both post to the account routes, which take
// the account from the session. The passwords are sent exactly as typed.
export function AccountForms({
  displayCurrency,
}: {
  displayCurrency: { country: string; chosen: string | null };
}) {
  // MC2-L5: which currency prices are shown in as an estimate. 'auto' is no choice: derived from the country.
  const [shownIn, setShownIn] = useState<string>(
    isDisplayCurrency(displayCurrency.chosen) ? displayCurrency.chosen : 'auto',
  );
  const [dcBusy, setDcBusy] = useState(false);
  const [dcSaved, setDcSaved] = useState(false);
  const [dcFailed, setDcFailed] = useState(false);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [allBusy, setAllBusy] = useState(false);
  const [allFailed, setAllFailed] = useState(false);

  async function change(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== repeat) {
      setError(SIGNUP_MISMATCH);
      return;
    }
    setBusy(true);
    const r = await postJson('/api/accounts/password', {
      current_password: current,
      new_password: next,
    });
    setBusy(false);
    if (!r.ok) {
      setError(
        r.code === 'weak_password'
          ? r.message
          : accountPasswordErrorText(r.status === 0 ? 'other' : r.code),
      );
      return;
    }
    setCurrent('');
    setNext('');
    setRepeat('');
    setDone(true);
  }

  async function saveDisplay(e: React.FormEvent) {
    e.preventDefault();
    setDcBusy(true);
    setDcSaved(false);
    setDcFailed(false);
    const r = await postJson('/api/accounts/display-currency', { currency: shownIn });
    setDcBusy(false);
    if (r.ok) setDcSaved(true);
    else setDcFailed(true);
  }

  async function everywhere() {
    setAllBusy(true);
    setAllFailed(false);
    const r = await postJson('/api/accounts/sessions/revoke-all', {});
    if (!r.ok) {
      setAllBusy(false);
      setAllFailed(true);
      return;
    }
    try {
      window.sessionStorage.clear();
    } catch {
      /* private mode: nothing was kept */
    }
    window.location.assign('/');
  }

  return (
    <div className="auth-panels">
      <form className="auth-form" onSubmit={change} noValidate data-testid="account-password-form">
        <h2>{ACCOUNT_PASSWORD_TITLE}</h2>
        {error ? <ErrorState title={ACCOUNT_ERROR_TITLE}>{error}</ErrorState> : null}
        <p role="status" className="auth-done" data-testid="account-changed">
          {done ? ACCOUNT_CHANGED : ''}
        </p>
        <PasswordField
          id="ac-current"
          label={ACCOUNT_FIELD_CURRENT}
          value={current}
          onChange={setCurrent}
          shown={shown}
          autoComplete="current-password"
        />
        <ul className="auth-rules" id="ac-rules">
          {SIGNUP_PASSWORD_RULES.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <PasswordField
          id="ac-new"
          label={ACCOUNT_FIELD_NEW}
          value={next}
          onChange={setNext}
          shown={shown}
          autoComplete="new-password"
          describedBy="ac-rules"
        />
        <PasswordField
          id="ac-repeat"
          label={ACCOUNT_FIELD_REPEAT}
          value={repeat}
          onChange={setRepeat}
          shown={shown}
          autoComplete="new-password"
        />
        <ShowPasswordButton
          shown={shown}
          onToggle={() => setShown(!shown)}
          controls="ac-current ac-new ac-repeat"
        />
        <p>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || current === '' || next === '' || repeat === ''}
          >
            {busy ? ACCOUNT_CHANGE_BUSY : ACCOUNT_CHANGE}
          </button>
        </p>
      </form>
      <form
        className="auth-card"
        onSubmit={saveDisplay}
        aria-labelledby="ac-display-title"
        data-testid="account-display-form"
      >
        <h2 id="ac-display-title">{DISPLAY_CURRENCY_TITLE}</h2>
        <p>{DISPLAY_CURRENCY_LEDE}</p>
        <p>
          <label htmlFor="ac-display">{DISPLAY_CURRENCY_LABEL}</label>
          <select
            id="ac-display"
            value={shownIn}
            onChange={(e) => {
              setShownIn(e.target.value);
              setDcSaved(false);
            }}
          >
            <option value="auto">{autoOptionLabel(displayCurrency.country)}</option>
            {DISPLAY_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {DISPLAY_CURRENCY_OPTION[c]}
              </option>
            ))}
          </select>
        </p>
        <p>
          <button className="btn" type="submit" disabled={dcBusy}>
            {dcBusy ? DISPLAY_CURRENCY_SAVING : DISPLAY_CURRENCY_SAVE}
          </button>
        </p>
        <p role="status" className="muted" data-testid="account-display-status">
          {dcSaved ? DISPLAY_CURRENCY_SAVED : dcFailed ? DISPLAY_CURRENCY_FAILED : ''}
        </p>
      </form>
      <section className="auth-card" aria-labelledby="ac-all-title">
        <h2 id="ac-all-title">{ACCOUNT_ALL_TITLE}</h2>
        <p>{ACCOUNT_ALL_LEDE}</p>
        <p>
          <button
            type="button"
            className="btn"
            onClick={() => void everywhere()}
            disabled={allBusy}
          >
            {allBusy ? ACCOUNT_ALL_BUSY : ACCOUNT_ALL_BUTTON}
          </button>
        </p>
        <p role="status" className="muted">
          {allFailed ? ACCOUNT_ALL_FAILED : ''}
        </p>
      </section>
    </div>
  );
}
