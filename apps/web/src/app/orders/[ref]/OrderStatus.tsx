'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getJson } from '../../../lib/client-api';
import type { OrderView } from '../../../lib/view-types';
import { keepPolling, orderTone } from '../../../lib/order-status';
import { orderActions } from '../../../lib/order-actions';
import { StatusBanner } from '../../../ui/StatusBanner';
import { OrderActions } from './OrderActions';

// Live status in an aria-live region (A11Y-4). Polls while the order is not terminal; one text change
// per status change, never a flicker.
export function OrderStatus({ initial }: { initial: OrderView }) {
  const [view, setView] = useState(initial);
  // A frozen order, or any order with an item on hold, is settled, but its case appears a moment
  // later (the recovery rules run in the job loop), so keep looking until the case shows.
  const polling = keepPolling(view);
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => {
      void getJson<OrderView>(`/api/orders/${encodeURIComponent(view.order_ref)}`).then((r) => {
        if (r.ok) setView(r.data);
      });
    }, 3000);
    return () => clearInterval(t);
  }, [polling, view.order_ref]);
  const tone = orderTone(view);
  // ORDER-A: resume and cancel, for an order that waits for its buyer and no other status.
  const acts = orderActions(view);
  return (
    <>
      <div aria-live="polite" aria-atomic="true" data-testid="order-live">
        <StatusBanner tone={tone} live={false} title={view.buyer_message} />
        <ul>
          {view.items.map((i) => (
            <li key={i.article_id} data-testid="order-item">
              {i.title}
              {i.publisher === undefined ? '' : `, ${i.publisher}`}:{' '}
              {i.line !== undefined
                ? i.line
                : i.access === 'available'
                  ? 'ready'
                  : i.access === 'locked'
                    ? 'not unlocked yet'
                    : i.access === 'revoked'
                      ? 'access has ended'
                      : i.access}
            </li>
          ))}
        </ul>
      </div>
      {view.open_case !== null ? (
        <p data-testid="order-case">
          We opened case {view.open_case.case_id}. {view.open_case.buyer_message}
        </p>
      ) : null}
      {view.refund_line !== null ? <p data-testid="order-refund">{view.refund_line}</p> : null}
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
      {acts.resume || acts.cancel ? <OrderActions order={view} /> : null}
    </>
  );
}
