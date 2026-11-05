'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { postJson } from '../../lib/client-api';
import type { AlertActionView, AlertDetailView } from '../../lib/ops-alerts-view';
import { ErrorState } from '../ErrorState';
import './ops-a.css';

// INT-OPS-A / OPS-A.3: one alert. The cause, the money at risk, the one fix link, the links to the order and the
// case, the history, and the buttons AL allows in this state. A button posts to AL's own route with the
// single-use key the page made on the server. Without the authenticator code every button is off and says so.
function ActionForm({ view, action }: { view: AlertDetailView; action: AlertActionView }) {
  const router = useRouter();
  const [reason, setReason] = useState(action.reasons?.[0]?.code ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  async function press() {
    setBusy(true);
    setError(null);
    const body = action.kind === 'resolve' ? { reason_code: reason, ...(note.trim() === '' ? {} : { note }) } : {};
    const r = await postJson<{ state: string }>(action.path, body, { 'idempotency-key': action.key });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Please sign in again.' : r.message);
      return;
    }
    setDone(true);
    router.refresh();
  }
  const id = `${view.id}-${action.kind}`;
  return (
    <form
      className="ola-action"
      aria-label={`${action.label} this alert`}
      onSubmit={(e) => {
        e.preventDefault();
        if (action.enabled && !busy && !done) void press();
      }}
    >
      {action.reasons !== undefined ? (
        <>
          <div className="field">
            <label htmlFor={`${id}-reason`}>Reason</label>
            <select
              id={`${id}-reason`}
              value={reason}
              disabled={!action.enabled || busy}
              onChange={(e) => setReason(e.target.value)}
            >
              {action.reasons.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-note`}>Note (optional)</label>
            <input
              id={`${id}-note`}
              type="text"
              maxLength={200}
              value={note}
              disabled={!action.enabled || busy}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </>
      ) : null}
      <div>
        <button type="submit" className="btn" disabled={!action.enabled || busy || done}>
          {action.label}
        </button>
        {action.hint !== null ? <span className="ola-hint"> {action.hint}</span> : null}
      </div>
      <div aria-live="polite">{done ? 'Done.' : null}</div>
      {error !== null ? <ErrorState title="Not saved">{error}</ErrorState> : null}
    </form>
  );
}

export function AlertDetail({ view }: { view: AlertDetailView }) {
  return (
    <>
      <dl className="pk-facts">
        <dt>Severity</dt>
        <dd>{view.severity_word}</dd>
        <dt>State</dt>
        <dd data-testid="alert-state">{view.state_word}</dd>
        <dt>Raised</dt>
        <dd>{view.when}</dd>
        <dt>Cause</dt>
        <dd>{view.cause}</dd>
        <dt>What to do</dt>
        <dd>{view.next_action}</dd>
        {view.money_text !== null ? (
          <>
            <dt>Money</dt>
            <dd>{view.money_text}</dd>
          </>
        ) : null}
      </dl>
      <p className="ola-toolbar">
        <Link className="btn btn-primary" href={view.fix.href} data-testid="alert-fix">
          {view.fix.label}
        </Link>
        {view.order_href !== null ? <Link href={view.order_href}>Open the order</Link> : null}
        {view.case_href !== null ? <Link href={view.case_href}>Open the case</Link> : null}
      </p>
      <section aria-label="Actions" className="ola-actions">
        {view.actions.map((a) => (
          <ActionForm key={a.kind} view={view} action={a} />
        ))}
      </section>
      <section aria-label="History">
        <h2>History</h2>
        {view.history.length === 0 ? (
          <p className="oh-empty">No one has acted on this alert yet.</p>
        ) : (
          <ol className="ola-history">
            {view.history.map((h, i) => (
              <li key={`${String(i)}-${h.when}`}>
                {h.text}, {h.when}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
