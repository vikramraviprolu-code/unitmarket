'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../lib/client-api';
import { formatMinor } from '../../lib/format';
import { parseAmount } from '../../lib/refund-amount';
import {
  answerTone,
  openRequestWaitText,
  refreshAfterFailure,
  refundFailureView,
  unitLine,
} from '../../lib/refund-answer';
import type { RefundOverview, RefundUnitView } from '../../lib/view-types';
import { ErrorState } from '../../ui/ErrorState';

// The operator's refund form (CO-8, P9). Shown only to a session with the second factor; the route
// refuses any other. One form per captured unit: the amount is optional ("Refund the rest" when it is
// empty), the reason is required. Each form carries a single-use Idempotency-Key made by the server;
// after an answer the page is re-read, which brings a fresh key, so a second click cannot repeat a
// refund. One live region announces the answer (A11Y-4); errors say what to do next (A11Y-7).

// The result line names the order too: two cards can share a title (CO-8c).
const unitLabel = (u: RefundUnitView): string => unitLine(u.titles, u.order_ref);

type Answer =
  | { kind: 'ok'; message: string; tone: 'success' | 'warn'; label: string | null }
  | { kind: 'error'; title: string; message: string };

export function RefundPanel({ overview, keys }: { overview: RefundOverview; keys: string[] }) {
  const router = useRouter();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [usedKeys, setUsedKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const result = useRef<HTMLDivElement>(null);
  // After a refund the card may be gone (a full refund removes it), so focus would be lost: it moves
  // to the answer (CO-8b L6).
  useEffect(() => {
    if (answer?.kind === 'ok') result.current?.focus();
  }, [answer]);

  async function send(unit: RefundUnitView, key: string, amount: number | null, reason: string) {
    setBusy(unit.unit_id);
    setAnswer(null);
    const r = await postJson<{ message: string; state?: string }>(
      '/api/refunds',
      { unit_id: unit.unit_id, amount_minor: amount, reason },
      { 'idempotency-key': key },
    );
    setBusy(null);
    if (!r.ok) {
      // Only a clear refusal says nothing was refunded; any other failure may hide a refund that was
      // made (CO-8b M1). The key is kept either way: a retry with it replays, it cannot refund twice.
      setAnswer({ kind: 'error', ...refundFailureView(r) });
      // Only refunds_paused_midway: the open request and the paused banner are new, and the message
      // says to withdraw the request on this page. Never for an unknown outcome: a refresh brings a
      // new Idempotency-Key and removes the replay protection (CO-8c).
      if (refreshAfterFailure(r.code)) router.refresh();
      return false;
    }
    // The key is spent: the re-read page brings a new one.
    setUsedKeys((k) => [...k, key]);
    setAnswer({
      kind: 'ok',
      message: `${unitLabel(unit)}: ${r.data.message}`,
      ...answerTone(r.data.state),
    });
    router.refresh();
    return true;
  }

  async function withdraw(unit: RefundUnitView, id: string) {
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
    setAnswer({
      kind: 'ok',
      message: `${unitLabel(unit)}: the refund request was withdrawn. Nothing was refunded.`,
      ...answerTone('completed'),
    });
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
      <p className="muted">Only the 50 newest units are listed.</p>
      <div
        ref={result}
        tabIndex={-1}
        aria-live="polite"
        aria-atomic="true"
        data-testid="refund-result"
      >
        {answer?.kind === 'ok' ? (
          <p className={answer.tone === 'success' ? 'banner banner-success' : 'banner banner-warn'}>
            {answer.label !== null ? (
              <strong className="banner-title">{answer.label}</strong>
            ) : null}
            {answer.message}
          </p>
        ) : null}
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
  withdraw: (unit: RefundUnitView, id: string) => Promise<void>;
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
                  onClick={() => void withdraw(unit, r.refund_request_id)}
                >
                  Withdraw this request
                </button>
              ) : (
                openRequestWaitText(r.state)
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
              aria-describedby={`reason-hint-${unit.unit_id}`}
              onChange={(e) => setReason(e.target.value)}
            />
            <span
              id={`reason-hint-${unit.unit_id}`}
              className="hint"
              data-testid="refund-reason-hint"
            >
              {reason.trim().length < 3
                ? 'Enter a reason of at least 3 characters to enable the button.'
                : spent
                  ? 'Updating this page. The button is ready again in a moment.'
                  : ''}
            </span>
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
