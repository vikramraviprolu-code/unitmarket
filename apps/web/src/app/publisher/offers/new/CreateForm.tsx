'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../../lib/client-api';
import { parsePriceMinor, offerErrorText } from '../../../../lib/offer-copy';
import {
  CREATE_ARTICLE_LABEL,
  CREATE_LABEL,
  createErrorText,
  createdText,
} from '../../../../lib/publisher-e1-copy';
import { ErrorState } from '../../../../ui/ErrorState';

interface Row {
  option: 'keep_retrieve' | 'online_read';
  offeredLabel: string;
  priceLabel: string;
  optionName: string;
}

// PUB-E1: the create form. The body is the article id, the offered options with their prices in minor units
// and the tick. Nothing else leaves the browser: the publisher, the currency, the terms and the licence are
// not editable and not sent. The route and the domain check everything again; this form spares a round trip.
export function CreateForm({
  articles,
  capMinor,
  hint,
  attestLabel,
  rows,
}: {
  articles: { id: string; title: string }[];
  capMinor: number;
  hint: string;
  attestLabel: string;
  rows: Row[];
}) {
  const router = useRouter();
  const [article, setArticle] = useState(articles[0]?.id ?? '');
  const [offered, setOffered] = useState<Record<string, boolean>>(
    Object.fromEntries(rows.map((r) => [r.option, true])),
  );
  const [prices, setPrices] = useState<Record<string, string>>(
    Object.fromEntries(rows.map((r) => [r.option, ''])),
  );
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
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
    const res = await postJson<{ offer_id: string; version: string }>(
      '/api/publisher/offers/create',
      { article_id: article, options, attestation: attest },
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.status === 401 ? 'Please sign in again.' : createErrorText(res.code));
      return;
    }
    setAttest(false);
    setDone(createdText(res.data.version));
    router.push(`/publisher/offers/${encodeURIComponent(res.data.offer_id)}`);
  }

  return (
    <form onSubmit={(e) => void save(e)} aria-label={CREATE_LABEL}>
      <div className="field">
        <label htmlFor="create-article">{CREATE_ARTICLE_LABEL}</label>
        <select id="create-article" value={article} onChange={(e) => setArticle(e.target.value)}>
          {articles.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}
            </option>
          ))}
        </select>
      </div>
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
        <span>{attestLabel}</span>
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy || !attest}>
        {CREATE_LABEL}
      </button>
      <div aria-live="polite" data-testid="offer-create-result">
        {done}
      </div>
      {error ? <ErrorState title="Could not create the offer">{error}</ErrorState> : null}
    </form>
  );
}
