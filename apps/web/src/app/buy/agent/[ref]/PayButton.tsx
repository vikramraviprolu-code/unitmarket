'use client';
import { useState } from 'react';
import { postJson } from '../../../../lib/client-api';
import { RESUME_BUSY, RESUME_BUTTON } from '../../../../lib/order-actions';
import type { OrderView } from '../../../../lib/view-types';
import { ErrorState } from '../../../../ui/ErrorState';

// The one action on the handoff page: ask the existing checkout route for the payment link and go there.
// An order already waiting for its buyer gets its button from OrderStatus, so this shows for a new order only.
export function PayButton({ order }: { order: OrderView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    const co = await postJson<{ approve_url: string }>(
      `/api/orders/${encodeURIComponent(order.order_ref)}/checkout`,
      {},
    );
    if (!co.ok) {
      setBusy(false);
      setError(co.message);
      return;
    }
    window.location.assign(
      order.environment === 'dryrun'
        ? `/checkout/dry-run/${encodeURIComponent(order.order_ref)}`
        : co.data.approve_url,
    );
  }

  return (
    <>
      {error !== null ? <ErrorState title="Nothing was changed">{error}</ErrorState> : null}
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void pay()}
        >
          {busy ? RESUME_BUSY : RESUME_BUTTON}
        </button>
      </div>
    </>
  );
}
