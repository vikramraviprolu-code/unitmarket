'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../lib/client-api';
import {
  ADD_BUTTON,
  APPROVE_BUTTON,
  DONE_ADDED,
  DONE_APPROVED,
  DONE_REJECTED,
  FIELD_COUNTRY,
  FIELD_NAME,
  FIELD_NOTE,
  FIELD_SLUG,
  REJECT_BUTTON,
  applicantErrorText,
  decisionReasonLabel,
} from '../../../lib/ops-applicants-copy';
import { OPS_NEEDS_CODE } from '../../../lib/ops-copy';
import { ErrorState } from '../../../ui/ErrorState';
import { InviteCodePanel } from './InviteCodePanel';

// PUB-E2: the add form and the answer form of the Applicants section. They only carry what the operator
// typed; the routes check everything again (operator, second factor, CSRF, shape, status rules).
export function AddApplicantForm({ hasCode }: { hasCode: boolean }) {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [country, setCountry] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    setDone(null);
    const r = await postJson<{ publisher_id: string }>('/api/ops/publishers/applicants', {
      slug,
      display_name: displayName,
      country,
      reason,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Please sign in again.' : applicantErrorText(r.code));
      return;
    }
    setSlug('');
    setDisplayName('');
    setCountry('');
    setReason('');
    setDone(DONE_ADDED);
    router.refresh();
  }

  return (
    <div>
      <div className="pk-form-grid">
        <div className="field">
          <label htmlFor="applicant-name">{FIELD_NAME}</label>
          <input
            id="applicant-name"
            type="text"
            maxLength={80}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="applicant-slug">{FIELD_SLUG}</label>
          <input
            id="applicant-slug"
            type="text"
            maxLength={40}
            autoCapitalize="none"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="applicant-country">{FIELD_COUNTRY}</label>
          <input
            id="applicant-country"
            type="text"
            maxLength={2}
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="applicant-note">{FIELD_NOTE}</label>
          <input
            id="applicant-note"
            type="text"
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            !hasCode ||
            busy ||
            reason.trim().length < 3 ||
            slug.length < 3 ||
            displayName.trim().length < 2
          }
          onClick={() => void add()}
        >
          {ADD_BUTTON}
        </button>
        {hasCode ? null : <span className="muted"> {OPS_NEEDS_CODE}</span>}
      </div>
      <div aria-live="polite">{done}</div>
      {error ? <ErrorState title="Not saved">{error}</ErrorState> : null}
    </div>
  );
}

export function DecideApplicantForm({
  publisherId,
  name,
  hasCode,
}: {
  publisherId: string;
  name: string;
  hasCode: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // POB-P1: the invite code of an approval lives here until the operator confirms they copied it. The row
  // leaves the list on refresh, so refreshing is held back until then.
  const [invite, setInvite] = useState<{ code: string; expires_at: string } | null>(null);

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    setDone(null);
    const r = await postJson<{ state: string; invite?: { code: string; expires_at: string } }>(
      '/api/ops/publishers/applicants/decision',
      {
        publisher_id: publisherId,
        decision,
        reason,
      },
    );
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Please sign in again.' : applicantErrorText(r.code));
      return;
    }
    setReason('');
    setDone(decision === 'approve' ? DONE_APPROVED : DONE_REJECTED);
    if (r.data.invite !== undefined) {
      setInvite(r.data.invite);
      return;
    }
    router.refresh();
  }

  if (invite !== null)
    return (
      <div>
        <div aria-live="polite">{done}</div>
        <InviteCodePanel
          code={invite.code}
          expiresAt={invite.expires_at}
          onDone={() => {
            setInvite(null);
            router.refresh();
          }}
        />
      </div>
    );

  return (
    <div>
      <div className="field">
        <label htmlFor={`decision-${publisherId}`}>{decisionReasonLabel(name)}</label>
        <input
          id={`decision-${publisherId}`}
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
          disabled={!hasCode || busy || reason.trim().length < 3}
          onClick={() => void decide('approve')}
        >
          {APPROVE_BUTTON}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!hasCode || busy || reason.trim().length < 3}
          onClick={() => void decide('reject')}
        >
          {REJECT_BUTTON}
        </button>
        {hasCode ? null : <span className="muted"> {OPS_NEEDS_CODE}</span>}
      </div>
      <div aria-live="polite">{done}</div>
      {error ? <ErrorState title="Not saved">{error}</ErrorState> : null}
    </div>
  );
}
