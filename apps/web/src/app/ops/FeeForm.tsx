'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../lib/client-api';
import {
  FEE_BAD_INPUT,
  FEE_INPUT_LABEL,
  FEE_REASON_LABEL,
  FEE_SAVED,
  FEE_SUBMIT,
  bpsToPercentText,
  percentToBps,
} from '../../lib/payout-copy';
import { ErrorState } from '../../ui/ErrorState';

// The operator's fee form (POB-M1, D-089). Shown only to a session with the second factor; the route refuses any other. The
// operator types a percent from 0 to 30; the form sends whole basis points. One single-use Idempotency-Key made by the server:
// after an answer the page is read again, which brings a fresh key, so a second click cannot set the fee twice.
export function FeeForm({ currentBps, idemKey }: { currentBps: number; idemKey: string }) {
  const router = useRouter();
  const [percent, setPercent] = useState(bpsToPercentText(currentBps));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(false);
  const [answer, setAnswer] = useState<{ ok: boolean; message: string } | null>(null);
  const rate = percentToBps(percent);
  const ready = !busy && !spent && rate !== null && reason.trim().length >= 3 && idemKey !== '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rate === null) return;
    setBusy(true);
    setAnswer(null);
    const r = await postJson<{ fee_bps: number }>(
      '/api/ops/fee',
      { fee_bps: rate, reason: reason.trim() },
      { 'idempotency-key': idemKey },
    );
    setBusy(false);
    if (!r.ok) {
      setAnswer({ ok: false, message: r.message });
      return;
    }
    setSpent(true);
    setAnswer({ ok: true, message: FEE_SAVED });
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void submit(e)} data-testid="fee-form" className="pk-panel">
      <p>
        <label htmlFor="fee-percent">{FEE_INPUT_LABEL}</label>
        <br />
        <input
          id="fee-percent"
          name="fee-percent"
          inputMode="decimal"
          autoComplete="off"
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
          aria-invalid={rate === null}
          aria-describedby="fee-percent-help"
        />
      </p>
      <p id="fee-percent-help" className="muted" aria-live="polite">
        {rate === null ? FEE_BAD_INPUT : ''}
      </p>
      <p>
        <label htmlFor="fee-reason">{FEE_REASON_LABEL}</label>
        <br />
        <input
          id="fee-reason"
          name="fee-reason"
          autoComplete="off"
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </p>
      <p>
        <button type="submit" disabled={!ready}>
          {FEE_SUBMIT}
        </button>
      </p>
      <div aria-live="polite" aria-atomic="true" data-testid="fee-result">
        {answer?.ok === true ? <p className="banner banner-success">{answer.message}</p> : null}
      </div>
      {answer?.ok === false ? (
        <ErrorState title="The fee was not set">{answer.message}</ErrorState>
      ) : null}
    </form>
  );
}
