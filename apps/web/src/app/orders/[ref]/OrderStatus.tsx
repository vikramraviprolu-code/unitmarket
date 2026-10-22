'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getJson } from '../../../lib/client-api';
import type { OrderView } from '../../../lib/view-types';
import { StatusBanner } from '../../../ui/StatusBanner';

const TERMINAL = new Set(['paid', 'paid_partial', 'failed', 'abandoned', 'frozen']);

// Live status in an aria-live region (A11Y-4). Polls while the order is not terminal; one text change
// per status change, never a flicker.
export function OrderStatus({ initial }: { initial: OrderView }) {
  const [view, setView] = useState(initial);
  useEffect(() => {
    if (TERMINAL.has(view.status)) return;
    const t = setInterval(() => {
      void getJson<OrderView>(`/api/orders/${encodeURIComponent(view.order_ref)}`).then((r) => {
        if (r.ok) setView(r.data);
      });
    }, 3000);
    return () => clearInterval(t);
  }, [view.status, view.order_ref]);
  const tone =
    view.status === 'paid' || view.status === 'paid_partial'
      ? 'success'
      : view.status === 'frozen'
        ? 'warn'
        : view.status === 'failed'
          ? 'error'
          : 'info';
  return (
    <>
      <div aria-live="polite" aria-atomic="true" data-testid="order-live">
        <StatusBanner tone={tone} live={false} title={view.buyer_message} />
      </div>
      <ul>
        {view.items.map((i) => (
          <li key={i.article_id}>
            {i.title}:{' '}
            {i.access === 'available'
              ? 'ready'
              : i.access === 'locked'
                ? 'not unlocked yet'
                : i.access}
          </li>
        ))}
      </ul>
      <div className="actions">
        {view.status === 'paid' || view.status === 'paid_partial' ? (
          <>
            <Link className="btn btn-primary" href="/library">
              Open my library
            </Link>
            <Link className="btn" href={`/receipts/${encodeURIComponent(view.order_id)}`}>
              View receipt
            </Link>
          </>
        ) : null}
        {view.status === 'frozen' || view.status === 'unresolved' ? (
          <Link className="btn" href="/help/frozen">
            What does this mean?
          </Link>
        ) : null}
      </div>
    </>
  );
}
