'use client';
import { useState } from 'react';
import { postJson, recall, remember } from '../../../lib/client-api';
import { optionLabel, formatMinor, formatDateTime } from '../../../lib/format';
import type { ApprovalView } from '../../../lib/view-types';
import { Countdown } from '../../../ui/Countdown';
import { ErrorState } from '../../../ui/ErrorState';
import { StatusBanner } from '../../../ui/StatusBanner';

export function ApproveClient({ view, idemKey }: { view: ApprovalView; idemKey: string }) {
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
      setError(
        order.code === 'payments_not_wired'
          ? 'Checkout is not available in this build yet. Nothing was charged.'
          : order.message,
      );
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
        <ul>
          {view.items.map((it) => (
            <li key={it.article_id}>
              <strong>{it.title}</strong>, {it.publisher}
              <br />
              {optionLabel(it.option)}: {formatMinor(it.amount_minor, view.currency)}
            </li>
          ))}
        </ul>
        <p>
          Total:{' '}
          <strong className="price" data-testid="approve-total">
            {formatMinor(view.total_minor, view.currency)}
          </strong>
        </p>
        <p className="muted">
          This price and these terms are frozen until {formatDateTime(view.expires_at)}. Personal
          use only; 5 days of access starting when payment is confirmed.
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
