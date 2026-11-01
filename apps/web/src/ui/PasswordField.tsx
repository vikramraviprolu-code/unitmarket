'use client';
import { useId } from 'react';
import { SIGNUP_HIDE, SIGNUP_SHOW } from '../lib/account-copy';

// A labelled password field and its show and hide control (ID-ACCOUNTS). The parent holds `shown`, so one
// control can reveal two fields at once. The browser's own help is left on: no blocked input events, a
// password manager can fill and fill in the field, and `autoComplete` says whether this is a new password
// or the current one.
export function PasswordField({
  id,
  label,
  value,
  onChange,
  shown,
  autoComplete,
  hint,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  shown: boolean;
  autoComplete: 'new-password' | 'current-password';
  hint?: string;
  describedBy?: string;
}) {
  const hintId = `${id}-hint`;
  const described = [hint === undefined ? null : hintId, describedBy ?? null]
    .filter((x): x is string => x !== null)
    .join(' ');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint === undefined ? null : (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      )}
      <input
        id={id}
        name={id}
        type={shown ? 'text' : 'password'}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        {...(described === '' ? {} : { 'aria-describedby': described })}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function ShowPasswordButton({
  shown,
  onToggle,
  controls,
}: {
  shown: boolean;
  onToggle: () => void;
  controls: string;
}) {
  const uid = useId();
  return (
    <button
      type="button"
      id={`${uid}-toggle`}
      className="pw-toggle"
      aria-controls={controls}
      onClick={onToggle}
    >
      {shown ? SIGNUP_HIDE : SIGNUP_SHOW}
    </button>
  );
}
