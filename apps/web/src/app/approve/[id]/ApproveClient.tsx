'use client';
import { useState } from 'react';
import { postJson, recall, remember } from '../../../lib/client-api';
import { optionLabel, formatDateTime } from '../../../lib/format';
import type { ApprovePrices } from '../../../lib/buyer-price';
import type { ApprovalView } from '../../../lib/view-types';
import { Countdown } from '../../../ui/Countdown';
import { ErrorState } from '../../../ui/ErrorState';
import { StatusBanner } from '../../../ui/StatusBanner';
import { packNotice } from '../../../lib/composite-copy';

export function ApproveClient({
  view,
  idemKey,
  prices,
}: {
  view: ApprovalView;
  idemKey: string;
  /** MC2-L5: every figure as the buyer is shown it. The approval (`view`) is the seller's amount. */
  prices: ApprovePrices;
}) {
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    const token = recall(`um_apr_${view.approval_id}`);
    if (token === null) {
      setBusy(false);
      setError(
        'This approval was opened in another tab or has been cleared. Please start again from the offer.',
      );
      return;
    }
    const order = await postJson<{ order_ref: string }>(
      '/api/orders',
      { approval_id: view.approval_id, token },
      { 'idempotency-key': idemKey },
    );
    if (!order.ok) {
      setBusy(false);
      setError(order.message);
      return;
    }
    const co = await postJson<{ approve_url: string }>(
      `/api/orders/${encodeURIComponent(order.data.order_ref)}/checkout`,
      {},
    );
    if (!co.ok) {
      setBusy(false);
      setError(co.message);
      return;
    }
    window.location.assign(
      view.environment === 'dryrun'
        ? `/checkout/dry-run/${encodeURIComponent(order.data.order_ref)}`
        : co.data.approve_url,
    );
  }

  async function renew() {
    const saved = recall(`um_renew_${view.approval_id}`);
    if (saved === null) {
      setError('We cannot renew this one. Please start again from the offer.');
      return;
    }
    setRenewing(true);
    const r = await postJson<{ approval_id: string; token: string }>(
      '/api/approvals',
      JSON.parse(saved) as Record<string, unknown>,
    );
    setRenewing(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    remember(`um_apr_${r.data.approval_id}`, r.data.token);
    remember(`um_renew_${r.data.approval_id}`, saved);
    window.location.assign(`/approve/${encodeURIComponent(r.data.approval_id)}`);
  }

  return (
    <>
      <section className="card" aria-labelledby="summary">
        <h2 id="summary">What you are buying</h2>
        {view.settlement !== null ? (
          <>
            <p data-testid="pack-notice">{packNotice(view.settlement.payments)}</p>
            {view.blocks.map((b) => (
              <div key={b.publisher} data-testid="approve-block">
                <h3>{b.publisher}</h3>
                <ul>
                  {b.items.map((it) => (
                    <li key={it.article_id}>
                      <strong>{it.title}</strong>
                      <br />
                      {optionLabel(it.option)}: {prices.items[it.article_id]?.lead}
                      {prices.items[it.article_id]?.binding != null ? (
                        <>
                          <br />
                          <span className="muted binding-line">
                            {prices.items[it.article_id]!.binding}
                          </span>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p>
                  Subtotal for {b.publisher}: <strong>{prices.blocks[b.publisher]?.lead}</strong>
                </p>
                {prices.blocks[b.publisher]?.binding != null ? (
                  <p className="muted binding-line">{prices.blocks[b.publisher]!.binding}</p>
                ) : null}
              </div>
            ))}
          </>
        ) : (
          <ul>
            {view.items.map((it) => (
              <li key={it.article_id}>
                <strong>{it.title}</strong>, {it.publisher}
                <br />
                {optionLabel(it.option)}: {prices.items[it.article_id]?.lead}
                {prices.items[it.article_id]?.binding != null ? (
                  <>
                    <br />
                    <span className="muted binding-line">
                      {prices.items[it.article_id]!.binding}
                    </span>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p>
          Total:{' '}
          <strong className="price" data-testid="approve-total">
            {prices.total.lead}
          </strong>
        </p>
        {prices.total.binding !== null ? (
          <p className="muted binding-line" data-testid="approve-binding">
            {prices.total.binding}
          </p>
        ) : null}
        <p className="muted">
          This price and these terms are frozen until {formatDateTime(view.expires_at)}. Personal
          use only; {view.access_days} {view.access_days === 1 ? 'day' : 'days'} of access starting
          when payment is confirmed.
        </p>
      </section>
      <Countdown
        expiresAt={view.expires_at}
        nowIso={view.now}
        onRenew={() => void renew()}
        renewing={renewing}
      />
      {error ? <ErrorState title="We could not continue">{error}</ErrorState> : null}
      {view.used ? (
        <StatusBanner tone="info" title="Already used">
          This approval has already been used. Check your orders or start again.
        </StatusBanner>
      ) : (
        <>
          <label className="check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>
              I confirm the price and terms above, and that I accepted them on the previous step.
            </span>
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!agree || busy}
              onClick={() => void pay()}
            >
              {busy ? 'Starting checkout' : 'Continue to payment'}
            </button>
          </div>
        </>
      )}
    </>
  );
}
