'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../lib/client-api';
import {
  ACCESS_ISSUE_BUTTON,
  ACCESS_REPLACE_BUTTON,
  ACCESS_RESET_BUTTON,
  LINKS_DONE,
  LINKS_FIELD_REASON,
  LINKS_FIELD_RETYPE,
  LINKS_VERIFY,
  accessErrorText,
  accessReasonLabel,
  linkDecisionErrorText,
} from '../../../lib/publisher-accounts-copy';
import { ErrorState } from '../../../ui/ErrorState';
import { InviteCodePanel } from './InviteCodePanel';

// POB-P1: the forms of the Sign in access section. They only carry what the operator typed; the routes check
// everything again (operator, second factor, CSRF, shape, status rules).

/** Issue or replace the invite code (no account yet), or reset sign in (an account exists). */
export function AccessForm({
  publisherId,
  name,
  hasAccount,
  hasInvite,
}: {
  publisherId: string;
  name: string;
  hasAccount: boolean;
  hasInvite: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ code: string; expires_at: string } | null>(null);
  const action = hasAccount ? 'reset' : 'issue';

  async function send() {
    setBusy(true);
    setError(null);
    const r = await postJson<{ invite: { code: string; expires_at: string } }>(
      '/api/ops/publishers/access',
      { publisher_id: publisherId, action, reason },
    );
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Please sign in again.' : accessErrorText(r.code));
      return;
    }
    setReason('');
    setInvite(r.data.invite);
  }

  if (invite !== null)
    return (
      <InviteCodePanel
        code={invite.code}
        expiresAt={invite.expires_at}
        onDone={() => {
          setInvite(null);
          router.refresh();
        }}
      />
    );
  const id = `access-${publisherId}`;
  return (
    <div>
      <div className="field">
        <label htmlFor={id}>{accessReasonLabel(name)}</label>
        <input
          id={id}
          type="text"
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy || reason.trim().length < 3}
          onClick={() => void send()}
        >
          {hasAccount
            ? ACCESS_RESET_BUTTON
            : hasInvite
              ? ACCESS_REPLACE_BUTTON
              : ACCESS_ISSUE_BUTTON}
        </button>
      </div>
      {error ? <ErrorState title="Not saved">{error}</ErrorState> : null}
    </div>
  );
}

/** Mark a requested PayPal address as checked, after typing it again in full. */
export function VerifyLinkForm({ publisherId, name }: { publisherId: string; name: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    setBusy(true);
    setError(null);
    setDone(null);
    const r = await postJson<{ state: string }>('/api/ops/publishers/paypal-link-decisions', {
      publisher_id: publisherId,
      email_retyped: email,
      reason,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Please sign in again.' : linkDecisionErrorText(r.code));
      return;
    }
    setEmail('');
    setReason('');
    setDone(LINKS_DONE);
    router.refresh();
  }

  return (
    <div>
      <div className="field">
        <label htmlFor={`link-email-${publisherId}`}>
          {name}: {LINKS_FIELD_RETYPE}
        </label>
        <input
          id={`link-email-${publisherId}`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={320}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`link-reason-${publisherId}`}>
          {name}: {LINKS_FIELD_REASON}
        </label>
        <input
          id={`link-reason-${publisherId}`}
          type="text"
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || email.trim() === '' || reason.trim().length < 3}
          onClick={() => void verify()}
        >
          {LINKS_VERIFY}
        </button>
      </div>
      <div aria-live="polite">{done}</div>
      {error ? <ErrorState title="Not saved">{error}</ErrorState> : null}
    </div>
  );
}
