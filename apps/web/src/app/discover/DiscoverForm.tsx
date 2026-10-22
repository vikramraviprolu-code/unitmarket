'use client';
import { useState } from 'react';
import type { AccessOption, FitCard as FitCardData, Money } from '@umsbx/contracts';
import { postJson, remember } from '../../lib/client-api';
import { FitCard } from '../../ui/FitCard';
import { StatusBanner } from '../../ui/StatusBanner';
import { ErrorState } from '../../ui/ErrorState';

type Item = {
  quote: { quote_id: string; offer_id: string; option: AccessOption; price: Money };
  fit: FitCardData;
  title: string;
  publisher: string;
};
type Result =
  | { kind: 'proposal'; proposal_id: string; items: Item[] }
  | { kind: 'no_match'; reasons: string[] };

export function DiscoverForm({ signedIn }: { signedIn: boolean }) {
  const [need, setNeed] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function find(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    const r = await postJson<Result>('/api/discover', { need });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Please sign in first.' : r.message);
      return;
    }
    setResult(r.data);
  }

  async function choose(item: Item, proposalId: string) {
    if (!terms) {
      setError('Please accept the terms below before choosing an article.');
      return;
    }
    setError(null);
    const consent = { terms: true, identity_share: false };
    const r = await postJson<{ approval_id: string; token: string }>('/api/approvals', {
      proposal_id: proposalId,
      offer_ids: [item.quote.offer_id],
      consent,
    });
    if (!r.ok) {
      setError(r.message);
      return;
    }
    remember(`um_apr_${r.data.approval_id}`, r.data.token);
    remember(
      `um_renew_${r.data.approval_id}`,
      JSON.stringify({ proposal_id: proposalId, offer_ids: [item.quote.offer_id], consent }),
    );
    window.location.assign(`/approve/${encodeURIComponent(r.data.approval_id)}`);
  }

  return (
    <>
      {!signedIn ? (
        <StatusBanner tone="info" title="Sign in first">
          <a href="/signin?next=/discover">Sign in</a> to describe your need.
        </StatusBanner>
      ) : null}
      <form onSubmit={find} noValidate>
        <div className="field">
          <label htmlFor="need">What do you need?</label>
          <p className="hint" id="need-hint">
            For example: tide tables, under $1, read online. Include your ceiling in the words.
          </p>
          <textarea
            id="need"
            aria-describedby="need-hint"
            value={need}
            maxLength={2000}
            onChange={(e) => setNeed(e.target.value)}
          />
        </div>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={busy || !signedIn || need.trim() === ''}
        >
          {busy ? 'Searching' : 'Find articles'}
        </button>
      </form>
      <div aria-live="polite">
        {error ? <ErrorState title="Could not continue">{error}</ErrorState> : null}
        {result?.kind === 'no_match' ? (
          <StatusBanner tone="warn" title="No match">
            Nothing in the catalogue fits that need and ceiling. We do not stretch the match. Try
            different words or a higher ceiling.
          </StatusBanner>
        ) : null}
        {result?.kind === 'proposal' ? (
          <section aria-labelledby="results">
            <h2 id="results">Articles that fit</h2>
            <p className="muted">The cards are advice. You choose.</p>
            <label className="check">
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
              <span>I accept the terms of purchase for the article I choose.</span>
            </label>
            <div className="grid-2">
              {result.items.map((it) => (
                <FitCard
                  key={it.quote.offer_id}
                  card={it.fit}
                  title={it.title}
                  publisher={it.publisher}
                  price={it.quote.price}
                  option={it.quote.option}
                  onChoose={() => void choose(it, result.proposal_id)}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
