'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../lib/client-api';
import { caseActionRequest } from '../../lib/ops-cases-view';
import type { CaseActionView, CaseDetailView } from '../../lib/ops-cases-view';
import { ErrorState } from '../ErrorState';
import './ops-a.css';

// INT-OPS-A / OPS-A.5: one case. The message to the buyer is plain text the system wrote and is painted as text,
// never as markup. Each action posts to AL's route with the single-use key the page made on the server. Without the
// authenticator code every button is off and says so.
function ActionForm({ caseId, action }: { caseId: string; action: CaseActionView }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState('1');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function press() {
    setBusy(true);
    setError(null);
    const credit = action.needs_credit ? Math.round(Number(hours) * 3_600_000) : undefined;
    const req = caseActionRequest(caseId, action, reason, credit);
    const r = await postJson(req.path, req.body, req.headers);
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Please sign in again.' : r.message);
      return;
    }
    setDone(true);
    router.refresh();
  }
  const id = `${caseId}-${action.kind}`;
  const ready = action.enabled && reason.trim().length >= 3 && !busy && !done;
  return (
    <form
      className="ola-action"
      aria-label={action.label}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void press();
      }}
    >
      <div className="field">
        <label htmlFor={`${id}-reason`}>Why ({action.label})</label>
        <input
          id={`${id}-reason`}
          type="text"
          maxLength={200}
          value={reason}
          disabled={!action.enabled || busy}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {action.needs_credit ? (
        <div className="field">
          <label htmlFor={`${id}-hours`}>Extra hours of access</label>
          <input
            id={`${id}-hours`}
            type="number"
            min={1}
            max={720}
            value={hours}
            disabled={!action.enabled || busy}
            onChange={(e) => setHours(e.target.value)}
          />
        </div>
      ) : null}
      <div>
        <button type="submit" className="btn" disabled={!ready}>
          {action.label}
        </button>
        {action.hint !== null ? <span className="ola-hint"> {action.hint}</span> : null}
      </div>
      <div aria-live="polite">{done ? 'Done.' : null}</div>
      {error !== null ? <ErrorState title="Not saved">{error}</ErrorState> : null}
    </form>
  );
}

export function CaseCard({ view }: { view: CaseDetailView }) {
  return (
    <>
      <dl className="pk-facts">
        <dt>Kind</dt>
        <dd>{view.kind_word}</dd>
        <dt>State</dt>
        <dd data-testid="case-state">{view.state_word}</dd>
        <dt>Due</dt>
        <dd>{view.sla_text}</dd>
        {view.order_href !== null ? (
          <>
            <dt>Order</dt>
            <dd>
              <a href={view.order_href}>{view.order_ref}</a>
            </dd>
          </>
        ) : null}
      </dl>
      {view.buyer_message !== null ? (
        <section aria-label={view.buyer_message.label}>
          <h2>{view.buyer_message.label}</h2>
          <p data-testid="case-message">{view.buyer_message.text}</p>
        </section>
      ) : null}
      {view.alerts.length > 0 ? (
        <section aria-label="Alerts on this case">
          <h2>Alerts on this case</h2>
          <ul>
            {view.alerts.map((a) => (
              <li key={a.alert_id}>
                <a href={a.href}>{a.kind.replace(/_/g, ' ')}</a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {view.actions.length === 0 ? (
        <p className="oh-empty">This case is closed. There is nothing left to do.</p>
      ) : (
        <section aria-label="Actions" className="ola-actions">
          {view.actions.map((a) => (
            <ActionForm key={a.kind} caseId={view.case_id} action={a} />
          ))}
        </section>
      )}
    </>
  );
}
