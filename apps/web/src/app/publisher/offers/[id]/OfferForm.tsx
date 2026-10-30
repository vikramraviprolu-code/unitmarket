'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../../lib/client-api';
import {
  ATTEST_LABEL,
  SAVE_LABEL,
  WITHDRAWN_DONE,
  WITHDRAW_HEADING,
  WITHDRAW_LABEL,
  WITHDRAW_LEDE,
  WITHDRAW_REASON_LABEL,
  offerErrorText,
  parsePriceMinor,
  savedText,
} from '../../../../lib/offer-copy';
import { ErrorState } from '../../../../ui/ErrorState';

interface Row {
  option: 'keep_retrieve' | 'online_read';
  offeredLabel: string;
  priceLabel: string;
  offered: boolean;
  price: string;
}

// PUB-B: price and options of one offer. The body is the offer id, the version this page was opened at,
// the offered options with their prices in minor units and the tick. Nothing else leaves the browser:
// the publisher, the article, the terms and the access window are not editable and not sent. The route
// and the domain check everything again; this form only spares a round trip.
export function OfferForm({
  offerId,
  version,
  capMinor,
  hint,
  rows,
}: {
  offerId: string;
  version: string;
  capMinor: number;
  hint: string;
  rows: Row[];
}) {
  const router = useRouter();
  const [offered, setOffered] = useState<Record<string, boolean>>(
    Object.fromEntries(rows.map((r) => [r.option, r.offered])),
  );
  const [prices, setPrices] = useState<Record<string, string>>(
    Object.fromEntries(rows.map((r) => [r.option, r.price])),
  );
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(null);
    const options: { option: string; price_minor: number }[] = [];
    for (const r of rows) {
      if (offered[r.option] !== true) continue;
      const minor = parsePriceMinor(prices[r.option] ?? '');
      if (minor === null || minor < 1 || minor > capMinor) {
        setError(offerErrorText('invalid_price'));
        return;
      }
      options.push({ option: r.option, price_minor: minor });
    }
    if (options.length === 0) {
      setError(offerErrorText('invalid_options'));
      return;
    }
    setBusy(true);
    const res = await postJson<{ version: string }>('/api/publisher/offers/revise', {
      offer_id: offerId,
      expected_version: version,
      options,
      attestation: attest,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.status === 401 ? 'Please sign in again.' : offerErrorText(res.code));
      return;
    }
    setAttest(false);
    setSaved(savedText(res.data.version));
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void save(e)} aria-label={SAVE_LABEL}>
      {rows.map((r) => (
        <fieldset key={r.option} className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={offered[r.option] === true}
              onChange={(e) => setOffered({ ...offered, [r.option]: e.target.checked })}
            />
            <span>{r.offeredLabel}</span>
          </label>
          <label htmlFor={`price-${r.option}`}>{r.priceLabel}</label>
          <input
            id={`price-${r.option}`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            aria-describedby="price-hint"
            disabled={offered[r.option] !== true}
            value={prices[r.option] ?? ''}
            onChange={(e) => setPrices({ ...prices, [r.option]: e.target.value })}
          />
        </fieldset>
      ))}
      <p id="price-hint" className="muted">
        {hint}
      </p>
      <label className="check">
        <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
        <span>{ATTEST_LABEL}</span>
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy || !attest}>
        {SAVE_LABEL}
      </button>
      <div aria-live="polite" data-testid="offer-save-result">
        {saved}
      </div>
      {error ? <ErrorState title="Could not save">{error}</ErrorState> : null}
    </form>
  );
}

// PUB-B: withdraw. The body is the offer id, the version this page was opened at and the reason.
export function WithdrawForm({ offerId, version }: { offerId: string; version: string }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function withdraw(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await postJson<{ version: string }>('/api/publisher/offers/withdraw', {
      offer_id: offerId,
      expected_version: version,
      reason,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.status === 401 ? 'Please sign in again.' : offerErrorText(res.code));
      return;
    }
    setDone(true);
    router.refresh();
  }

  return (
    <section aria-labelledby="withdraw-heading">
      <h2 id="withdraw-heading">{WITHDRAW_HEADING}</h2>
      <p>{WITHDRAW_LEDE}</p>
      <form onSubmit={(e) => void withdraw(e)}>
        <div className="field">
          <label htmlFor="withdraw-reason">{WITHDRAW_REASON_LABEL}</label>
          <input
            id="withdraw-reason"
            type="text"
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <button type="submit" className="btn" disabled={busy || reason.trim().length < 3}>
          {WITHDRAW_LABEL}
        </button>
      </form>
      <div aria-live="polite" data-testid="offer-withdraw-result">
        {done ? WITHDRAWN_DONE : null}
      </div>
      {error ? <ErrorState title="Could not withdraw">{error}</ErrorState> : null}
    </section>
  );
}
