'use client';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AccessOption, FitCard as FitCardData, Money, Rights } from '@umsbx/contracts';
import { postJson, remember } from '../../lib/client-api';
import { FitCard } from '../../ui/FitCard';
import { Hero } from '../../ui/Hero';
import { StatusBanner } from '../../ui/StatusBanner';
import { ErrorState } from '../../ui/ErrorState';
import { BUY_SELECTED } from '../../lib/composite-copy';
import {
  BROWSE_EMPTY,
  BROWSE_HEADING,
  OPEN_ORDER_LINK,
  browseLinkText,
  discoverNoMatchView,
} from '../../lib/buyer-copy';
import type { BrowseEntry } from '../../lib/buyer-copy';
import { TermsConsent } from '../../ui/TermsConsent';

type Item = {
  quote: { quote_id: string; offer_id: string; option: AccessOption; price: Money };
  fit: FitCardData;
  title: string;
  publisher: string;
};
type Result =
  | { kind: 'proposal'; proposal_id: string; items: Item[] }
  | { kind: 'no_match'; reasons?: string[] };

// Gate 12 D12: the pack error sits next to the Buy button, so it is not far above it on a narrow screen.
const NO_TICK = 'Please accept the terms of purchase before buying.';

export function DiscoverForm({
  signedIn,
  browse,
  rights,
  initialNeed,
  children,
}: {
  signedIn: boolean;
  browse: BrowseEntry[];
  rights: Rights[];
  initialNeed: string;
  children: ReactNode;
}) {
  const [need, setNeed] = useState(initialNeed);
  const [result, setResult] = useState<Result | null>(null);
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [packError, setPackError] = useState<string | null>(null);
  // FIX-FLOW D10: after a search the results heading takes focus, so a keyboard user is not dropped on <body>.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (result !== null) headingRef.current?.focus();
  }, [result]);

  async function find(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    setPicked([]);
    setPackError(null);
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
      setError(NO_TICK);
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

  // OQ-17: several items in one approval. The server decides what may be bought together (one
  // currency, two publishers at most); the page only shows its plain-words answer.
  async function buySelected(proposalId: string) {
    if (!terms) {
      setPackError(NO_TICK);
      return;
    }
    setPackError(null);
    setError(null);
    const consent = { terms: true, identity_share: false };
    const r = await postJson<{ approval_id: string; token: string }>('/api/approvals', {
      proposal_id: proposalId,
      offer_ids: picked,
      consent,
    });
    if (!r.ok) {
      setError(r.message);
      return;
    }
    remember(`um_apr_${r.data.approval_id}`, r.data.token);
    remember(
      `um_renew_${r.data.approval_id}`,
      JSON.stringify({ proposal_id: proposalId, offer_ids: picked, consent }),
    );
    window.location.assign(`/approve/${encodeURIComponent(r.data.approval_id)}`);
  }

  function toggle(offerId: string) {
    setPicked((p) => (p.includes(offerId) ? p.filter((x) => x !== offerId) : [...p, offerId]));
  }

  const noMatch = discoverNoMatchView(result?.kind === 'no_match' ? (result.reasons ?? []) : []);
  return (
    <>
      <Hero>
        {children}
        <form onSubmit={find} noValidate>
          <label htmlFor="need">What do you need?</label>
          <p className="hint" id="need-hint">
            For example: tide tables, under $1, read online. Include your ceiling in the words.
          </p>
          <div className="search-pill">
            <input
              id="need"
              type="text"
              aria-describedby="need-hint"
              value={need}
              maxLength={2000}
              onChange={(e) => setNeed(e.target.value)}
            />
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy || !signedIn || need.trim() === ''}
            >
              {busy ? 'Searching' : 'Find articles'}
            </button>
          </div>
        </form>
      </Hero>
      {!signedIn ? (
        <StatusBanner tone="info" title="Sign in first">
          <a href="/signin?next=/discover">Sign in</a> to describe your need.
        </StatusBanner>
      ) : null}
      <div aria-live="polite">
        {error ? <ErrorState title="Could not continue">{error}</ErrorState> : null}
        {result?.kind === 'no_match' ? (
          <section aria-labelledby="results">
            <h2 id="results" tabIndex={-1} ref={headingRef}>
              {noMatch.open_order !== null && !noMatch.nothing_fits
                ? noMatch.open_order.heading
                : 'No match'}
            </h2>
            {noMatch.open_order !== null ? (
              <StatusBanner tone="info">
                {noMatch.open_order.body} <a href={noMatch.open_order.href}>{OPEN_ORDER_LINK}</a>
              </StatusBanner>
            ) : null}
            {noMatch.nothing_fits ? (
              <StatusBanner tone="warn">
                Nothing in the catalogue fits that need and ceiling. We do not stretch the match.
                Try different words or a higher ceiling
                {browse.length > 0 ? (
                  <>
                    , or <a href="#browse-all">{browseLinkText(browse.length).toLowerCase()}</a>{' '}
                    yourself
                  </>
                ) : null}
                .
              </StatusBanner>
            ) : null}
          </section>
        ) : null}
        {result?.kind === 'no_match' ? (
          <section aria-labelledby="browse-all-heading" id="browse-all">
            <h2 id="browse-all-heading">{BROWSE_HEADING}</h2>
            {browse.length === 0 ? (
              <p className="muted">{BROWSE_EMPTY}</p>
            ) : (
              <ul data-testid="browse-all">
                {browse.map((b) => (
                  <li key={b.offer_id}>
                    <a href={b.href}>{b.title}</a>, {b.publisher}{' '}
                    <span className="muted">{b.price_text}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
        {result?.kind === 'proposal' ? (
          <section aria-labelledby="results">
            <h2 id="results" tabIndex={-1} ref={headingRef}>
              Articles that fit
            </h2>
            <p className="muted">The cards are advice. You choose.</p>
            <TermsConsent
              id="discover-terms"
              label="I accept the terms of purchase for the article I choose."
              checked={terms}
              onChange={(v) => {
                setTerms(v);
                if (v) setPackError(null);
              }}
              rights={rights}
            />
            <div className="grid-2">
              {result.items.map((it) => (
                <div key={it.quote.offer_id} className="pick">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={picked.includes(it.quote.offer_id)}
                      onChange={() => toggle(it.quote.offer_id)}
                    />
                    <span>Select {it.title} to buy together</span>
                  </label>
                  <FitCard
                    card={it.fit}
                    title={it.title}
                    publisher={it.publisher}
                    price={it.quote.price}
                    option={it.quote.option}
                    onChoose={() => void choose(it, result.proposal_id)}
                  />
                </div>
              ))}
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={picked.length < 2}
                aria-describedby={picked.length < 2 ? 'pack-hint' : undefined}
                onClick={() => void buySelected(result.proposal_id)}
              >
                {BUY_SELECTED}
              </button>
              {packError ? (
                <p id="pack-error" role="alert" data-testid="pack-error">
                  <strong>{packError}</strong>
                </p>
              ) : null}
              {picked.length < 2 ? (
                <span id="pack-hint" className="muted">
                  Select two or more articles to buy them together.
                </span>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
