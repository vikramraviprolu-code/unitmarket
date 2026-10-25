'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../lib/client-api';
import { formatMinor } from '../../lib/format';
import { parseAmount } from '../../lib/refund-amount';
import type { RefundOverview, RefundUnitView } from '../../lib/view-types';
import { ErrorState } from '../../ui/ErrorState';

// The operator's refund form (CO-8, P9). Shown only to a session with the second factor; the route
// refuses any other. One form per captured unit: the amount is optional ("Refund the rest" when it is
// empty), the reason is required. Each form carries a single-use Idempotency-Key made by the server;
// after an answer the page is re-read, which brings a fresh key, so a second click cannot repeat a
// refund. One live region announces the answer (A11Y-4); errors say what to do next (A11Y-7).

type Answer = { kind: 'ok'; message: string } | { kind: 'error'; title: string; message: string };

export function RefundPanel({ overview, keys }: { overview: RefundOverview; keys: string[] }) {
  const router = useRouter();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [usedKeys, setUsedKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function send(unit: RefundUnitView, key: string, amount: number | null, reason: string) {
    setBusy(unit.unit_id);
    setAnswer(null);
    const r = await postJson<{ message: string }>(
      '/api/refunds',
      { unit_id: unit.unit_id, amount_minor: amount, reason },
      { 'idempotency-key': key },
    );
    setBusy(null);
    if (!r.ok) {
      setAnswer({
        kind: 'error',
        title: 'Nothing was refunded',
        message:
          r.status === 401 ? 'Please sign in again with your authenticator code.' : r.message,
      });
      return false;
    }
    // The key is spent: the re-read page brings a new one.
    setUsedKeys((k) => [...k, key]);
    setAnswer({ kind: 'ok', message: r.data.message });
    router.refresh();
    return true;
  }

  async function withdraw(id: string) {
    setBusy(id);
    setAnswer(null);
    const r = await postJson<{ state: string }>(
      `/api/refunds/${encodeURIComponent(id)}/cancel`,
      {},
    );
    setBusy(null);
    if (!r.ok) {
      setAnswer({ kind: 'error', title: 'Could not withdraw', message: r.message });
      return;
    }
    setAnswer({ kind: 'ok', message: 'The refund request was withdrawn. Nothing was refunded.' });
    router.refresh();
  }

  return (
    <section aria-labelledby="refunds-heading" data-testid="refund-panel">
      <h2 id="refunds-heading">Refunds</h2>
      <p className="muted">
        A refund goes back to the buyer&apos;s PayPal. Leave the amount empty to refund the rest of
        what is left. The reason is sent to the buyer in PayPal&apos;s refund note and is kept in
        the audit log.
      </p>
      {!overview.enabled ? (
        <p className="banner banner-warn" data-testid="refund-paused">
          Refunds are paused (the refunds_enabled switch is off). Nothing can be refunded now. An
          open request can still be withdrawn.
        </p>
      ) : null}
      <div aria-live="polite" aria-atomic="true" data-testid="refund-result">
        {answer?.kind === 'ok' ? <p className="banner banner-success">{answer.message}</p> : null}
      </div>
      {answer?.kind === 'error' ? (
        <ErrorState title={answer.title}>{answer.message}</ErrorState>
      ) : null}
      {overview.units.length === 0 ? (
        <p className="muted">No captured payments to refund.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {overview.units.map((u, i) => (
            <UnitCard
              key={u.unit_id}
              unit={u}
              idemKey={keys[i] ?? ''}
              spent={usedKeys.includes(keys[i] ?? '')}
              enabled={overview.enabled}
              busy={busy}
              send={send}
              withdraw={withdraw}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function UnitCard({
  unit,
  idemKey,
  spent,
  enabled,
  busy,
  send,
  withdraw,
}: {
  unit: RefundUnitView;
  idemKey: string;
  spent: boolean;
  enabled: boolean;
  busy: string | null;
  send: (u: RefundUnitView, key: string, amount: number | null, reason: string) => Promise<boolean>;
  withdraw: (id: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const digits = unit.currency === 'JPY' ? 0 : 2;
  const minor = parseAmount(amount, digits);
  const amountBad = minor === undefined;
  const label = unit.titles.length > 0 ? unit.titles.join(', ') : unit.order_ref;
  const canForm = enabled && !unit.frozen && unit.remaining_minor > 0;
  const working = busy !== null;
  const ready = !working && !spent && !amountBad && reason.trim().length >= 3 && idemKey !== '';
  const verb =
    minor === null
      ? 'Refund the rest'
      : minor === undefined
        ? 'Refund'
        : `Refund ${formatMinor(minor, unit.currency)}`;
  return (
    <li className="card" data-testid="refund-unit" style={{ listStyle: 'none' }}>
      <h3 id={`unit-${unit.unit_id}`}>{label}</h3>
      <dl>
        <dt>Order</dt>
        <dd className="mono">{unit.order_ref}</dd>
        <dt>Paid</dt>
        <dd>{formatMinor(unit.amount_minor, unit.currency)}</dd>
        <dt>Refunded so far</dt>
        <dd>{formatMinor(unit.refunded_minor, unit.currency)}</dd>
        <dt>Left to refund</dt>
        <dd data-testid="refund-left">{formatMinor(unit.remaining_minor, unit.currency)}</dd>
      </dl>
      {unit.frozen ? (
        <p className="banner banner-warn">
          Frozen: a refund list from PayPal did not add up and a person must look. Nothing can be
          refunded until the flag is cleared. The buyer&apos;s access is unchanged.
        </p>
      ) : null}
      {unit.open_requests.length > 0 ? (
        <ul>
          {unit.open_requests.map((r) => (
            <li key={r.refund_request_id}>
              Open request for {formatMinor(r.amount_minor, unit.currency)} ({r.state}).{' '}
              {r.can_withdraw ? (
                <button
                  type="button"
                  className="btn"
                  disabled={working}
                  onClick={() => void withdraw(r.refund_request_id)}
                >
                  Withdraw this request
                </button>
              ) : (
                'Wait for it to finish.'
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {canForm ? (
        <form
          aria-labelledby={`unit-${unit.unit_id}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready || amountBad) return;
            void send(unit, idemKey, minor, reason.trim()).then((done) => {
              if (done) {
                setAmount('');
                setReason('');
              }
            });
          }}
        >
          <div className="field">
            <label htmlFor={`amount-${unit.unit_id}`}>
              Amount to refund in {unit.currency} (leave empty to refund the rest)
            </label>
            <input
              id={`amount-${unit.unit_id}`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              aria-invalid={amountBad}
              aria-describedby={`amount-hint-${unit.unit_id}`}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span id={`amount-hint-${unit.unit_id}`} className="hint">
              {amountBad
                ? 'Enter an amount like 1.50, or leave it empty to refund the rest.'
                : `Up to ${formatMinor(unit.remaining_minor, unit.currency)}.`}
            </span>
          </div>
          <div className="field">
            <label htmlFor={`reason-${unit.unit_id}`}>
              Reason (3 to 200 characters; the buyer sees it in PayPal&apos;s note)
            </label>
            <input
              id={`reason-${unit.unit_id}`}
              type="text"
              maxLength={200}
              autoComplete="off"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={!ready}>
              {verb}
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
