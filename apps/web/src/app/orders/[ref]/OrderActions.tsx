'use client';
import { useState } from 'react';
import { postJson } from '../../../lib/client-api';
import {
  CANCEL_BUSY,
  CANCEL_BUTTON,
  CANCEL_DONE,
  RESUME_BUSY,
  RESUME_BUTTON,
} from '../../../lib/order-actions';
import type { OrderView } from '../../../lib/view-types';
import { ErrorState } from '../../../ui/ErrorState';
import { StatusBanner } from '../../../ui/StatusBanner';

// ORDER-A: shown only for an order that waits for its buyer (orderActions). Resume asks the existing
// checkout route for the stored PayPal link (it creates no second PayPal order) and goes where the approval
// page goes. Cancel asks the cancel route; the server decides, and a refusal is shown in plain words.
export function OrderActions({ order }: { order: OrderView }) {
  const [busy, setBusy] = useState<'resume' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function resume() {
    setBusy('resume');
    setError(null);
    const co = await postJson<{ approve_url: string }>(
      `/api/orders/${encodeURIComponent(order.order_ref)}/checkout`,
      {},
    );
    if (!co.ok) {
      setBusy(null);
      setError(co.message);
      return;
    }
    window.location.assign(
      order.environment === 'dryrun'
        ? `/checkout/dry-run/${encodeURIComponent(order.order_ref)}`
        : co.data.approve_url,
    );
  }

  async function cancel() {
    setBusy('cancel');
    setError(null);
    const r = await postJson<{ status: string }>(
      `/api/orders/${encodeURIComponent(order.order_ref)}/cancel`,
      {},
    );
    setBusy(null);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setDone(true);
    window.location.reload();
  }

  if (done) return <StatusBanner tone="success" title={CANCEL_DONE} />;
  return (
    <>
      {error !== null ? <ErrorState title="Nothing was changed">{error}</ErrorState> : null}
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== null}
          onClick={() => void resume()}
        >
          {busy === 'resume' ? RESUME_BUSY : RESUME_BUTTON}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => void cancel()}
        >
          {busy === 'cancel' ? CANCEL_BUSY : CANCEL_BUTTON}
        </button>
      </div>
    </>
  );
}
