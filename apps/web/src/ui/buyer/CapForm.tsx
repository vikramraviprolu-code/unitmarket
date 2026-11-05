'use client';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { postJson } from '../../lib/client-api';
import { CAP_REFUSAL_WORDS, capRequest, idemFor } from '../../lib/buyer-agents-view';
import type { CapRequest } from '../../lib/buyer-agents-view';
import { CAP_CONFIRM_BUTTON, CAP_CONFIRM_NOTE, capConfirmSentence } from '../../lib/buyer-copy';
import './buyer.css';

// INT-BUY / BUY.1: New cap. The buyer fills money, count or both, and a day; Review shows the confirm sentence;
// the Confirm button sets terms_accepted and creates the cap (POST /api/buyer/mandates). Nothing is created before
// the confirm. The Idempotency-Key is the server's nonce plus a hash of the body, so a repeat of the same request
// replays and a changed request is a new one.
export function CapForm({
  keys,
  currency,
  nonce,
}: {
  keys: { id: string; label: string }[];
  currency: string;
  nonce: string;
}) {
  const router = useRouter();
  const uid = useId();
  const [key, setKey] = useState(keys[0]?.id ?? '');
  const [money, setMoney] = useState('');
  const [count, setCount] = useState('');
  const [day, setDay] = useState('');
  const [pending, setPending] = useState<CapRequest | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (keys.length === 0) return null;

  function review(e: React.FormEvent): void {
    e.preventDefault();
    setDone(false);
    const r = capRequest({
      agent_key_id: key,
      currency,
      money_text: money,
      count_text: count,
      until_day: day,
    });
    if (!r.ok) {
      setPending(null);
      setProblem(r.problem);
      return;
    }
    setProblem('');
    setPending(r.body);
  }

  async function confirm(): Promise<void> {
    if (pending === null) return;
    setBusy(true);
    // Pressing Confirm is the buyer's consent to the sentence shown, so only here does the body carry the flag.
    const body = { ...pending, terms_accepted: true };
    const r = await postJson<{ id: string }>('/api/buyer/mandates', body, {
      'idempotency-key': idemFor(nonce, body),
    });
    setBusy(false);
    if (!r.ok) {
      setProblem(CAP_REFUSAL_WORDS[r.code] ?? r.message);
      return;
    }
    setPending(null);
    setDone(true);
    setMoney('');
    setCount('');
    router.refresh();
  }

  return (
    <form className="cap-form" aria-label="New cap" onSubmit={review} data-testid="cap-form">
      <label htmlFor={`${uid}-key`}>
        Agent key
        <select id={`${uid}-key`} value={key} onChange={(e) => setKey(e.target.value)}>
          {keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${uid}-money`}>
        Money cap ({currency}), optional
        <input
          id={`${uid}-money`}
          inputMode="decimal"
          value={money}
          onChange={(e) => setMoney(e.target.value)}
        />
      </label>
      <label htmlFor={`${uid}-count`}>
        Number of purchases, optional
        <input
          id={`${uid}-count`}
          inputMode="numeric"
          value={count}
          onChange={(e) => setCount(e.target.value)}
        />
      </label>
      <label htmlFor={`${uid}-day`}>
        Ends on
        <input id={`${uid}-day`} type="date" value={day} onChange={(e) => setDay(e.target.value)} />
      </label>
      <p>
        <button type="submit" className="btn" disabled={busy}>
          Review the cap
        </button>
      </p>
      <div role="status" aria-live="polite" data-testid="cap-status">
        {pending !== null ? (
          <div className="cap-confirm">
            <p data-testid="cap-sentence">
              {capConfirmSentence({
                currency: pending.currency,
                max_total_minor: pending.max_total_minor ?? null,
                max_count: pending.max_count ?? null,
                expires_at: pending.expires_at,
              })}
            </p>
            <p>{CAP_CONFIRM_NOTE}</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void confirm()}
              disabled={busy}
            >
              {CAP_CONFIRM_BUTTON}
            </button>
          </div>
        ) : null}
        {done ? <p>The cap is set.</p> : null}
      </div>
      <div aria-live="polite">{problem !== '' ? <p role="alert">{problem}</p> : null}</div>
    </form>
  );
}
