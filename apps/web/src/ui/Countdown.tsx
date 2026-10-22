'use client';
import { useEffect, useState } from 'react';

const WARN_AT_S = 120;

// Counts down from the server's own clock reading, one tick per second, so the browser clock is
// never consulted. Announces once when two minutes remain (A11Y-5) and offers one-step renewal.
export function Countdown({
  expiresAt,
  nowIso,
  onRenew,
  renewing = false,
}: {
  expiresAt: string;
  nowIso: string;
  onRenew: () => void;
  renewing?: boolean;
}) {
  const initial = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.parse(nowIso)) / 1000));
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    setLeft(initial);
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [initial, expiresAt]);
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, '0');
  const warn = left > 0 && left <= WARN_AT_S;
  return (
    <div className="countdown" data-testid="countdown">
      <p>
        <span className="visually-hidden">Time left to approve: </span>
        <strong aria-hidden="true">
          {m}:{s}
        </strong>
        <span className="visually-hidden">
          {m} minutes {s} seconds
        </span>{' '}
        <span className="muted">to approve this price</span>
      </p>
      <div aria-live="assertive" aria-atomic="true" data-testid="countdown-live">
        {warn ? (
          <p className="warn-text">
            Two minutes left or less. Your price is held until the time runs out.
          </p>
        ) : null}
        {left === 0 ? <p className="warn-text">This approval has expired.</p> : null}
      </div>
      {warn || left === 0 ? (
        <button type="button" className="btn" onClick={onRenew} disabled={renewing}>
          {renewing ? 'Renewing' : 'Renew for another 15 minutes'}
        </button>
      ) : null}
    </div>
  );
}
