'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { OfferPage } from '../../../../lib/view-types';
import { OPTION_HELP, OPTION_LABEL, formatMinor } from '../../../../lib/format';
import { postJson, remember } from '../../../../lib/client-api';
import { StatusBanner } from '../../../../ui/StatusBanner';
import { ErrorState } from '../../../../ui/ErrorState';
import { TermsConsent } from '../../../../ui/TermsConsent';
import {
  NOT_ON_SALE_BODY,
  NOT_ON_SALE_HEADING,
  noMatchView,
  refusedQuoteView,
} from '../../../../lib/offer-flow-view';

type Quote = {
  kind: 'quote';
  quote_id: string;
  option: 'keep_retrieve' | 'online_read';
  price: { currency: string; minor: number };
  expires_at: string;
};
type NoMatch = { kind: 'no_match'; reason: string; order_ref?: string };

function toMinor(text: string): number | null | 'bad' {
  const t = text.trim();
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return 'bad';
  return Math.round(Number(t) * 100);
}

export function OfferFlow({ offer, signedIn }: { offer: OfferPage; signedIn: boolean }) {
  const [option, setOption] = useState(offer.options[0]?.option ?? 'online_read');
  const [ceiling, setCeiling] = useState('');
  const [proposal, setProposal] = useState('');
  const [result, setResult] = useState<Quote | NoMatch | null>(null);
  const [terms, setTerms] = useState(false);
  const [identity, setIdentity] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function quote(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRefusal(null);
    setResult(null);
    const c = toMinor(ceiling);
    const p = toMinor(proposal);
    if (c === 'bad' || p === 'bad') {
      setError('Enter amounts like 1.50, with up to two decimals.');
      return;
    }
    setBusy(true);
    const r = await postJson<Quote | NoMatch>('/api/quotes', {
      publisher: offer.publisher_slug,
      offer: offer.offer_code,
      option,
      ...(c !== null ? { ceiling_minor: c } : {}),
      ...(p !== null ? { proposed_minor: p } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Please sign in first.' : r.message);
      return;
    }
    setResult(r.data);
  }

  async function review() {
    if (result?.kind !== 'quote') return;
    setBusy(true);
    setError(null);
    const consent = { terms, identity_share: identity };
    const r = await postJson<{ approval_id: string; token: string }>('/api/approvals', {
      quote_id: result.quote_id,
      consent,
    });
    setBusy(false);
    if (!r.ok) {
      // GATEFIX2 item 5: a quote the server refuses is dropped with its card, and one message is shown.
      const refused = refusedQuoteView(r.code, r.message);
      if (refused.hideQuote) setResult(null);
      setRefusal(refused.title);
      setError(refused.body);
      return;
    }
    remember(`um_apr_${r.data.approval_id}`, r.data.token);
    remember(
      `um_renew_${r.data.approval_id}`,
      JSON.stringify({ quote_id: result.quote_id, consent }),
    );
    window.location.assign(`/approve/${encodeURIComponent(r.data.approval_id)}`);
  }

  const chosen = offer.options.find((o) => o.option === option);
  // GATEFIX2 item 7: a withdrawn, replaced or suspended offer advertises no price and has no form.
  if (!offer.on_sale) {
    return (
      <StatusBanner tone="warn" title={NOT_ON_SALE_HEADING}>
        {NOT_ON_SALE_BODY} <Link href="/discover">Find articles</Link>
      </StatusBanner>
    );
  }
  const noMatch = result?.kind === 'no_match' ? noMatchView(result.reason, result.order_ref) : null;
  return (
    <>
      {!signedIn ? (
        <StatusBanner tone="info" title="Sign in to see your price">
          <Link
            href={`/signin?next=${encodeURIComponent(`/o/${offer.publisher_slug}/${offer.offer_code}`)}`}
          >
            Sign in
          </Link>{' '}
          to get a quote.
        </StatusBanner>
      ) : null}
      <form onSubmit={quote} noValidate>
        <fieldset>
          <legend>How do you want to read it?</legend>
          {offer.options.map((o) => (
            <label key={o.option} className="radio">
              <input
                type="radio"
                name="option"
                value={o.option}
                checked={option === o.option}
                onChange={() => {
                  setOption(o.option);
                  setResult(null);
                }}
              />
              <span>
                <strong>{OPTION_LABEL[o.option]}</strong>:{' '}
                {formatMinor(o.price_minor, offer.currency)}
                <br />
                <span className="muted">{OPTION_HELP[o.option]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="ceiling">Your ceiling ({offer.currency}), optional</label>
          <p className="hint" id="ceiling-hint">
            The most you want to pay. If the price is higher, we show no match and nothing else.
          </p>
          <input
            id="ceiling"
            type="text"
            inputMode="decimal"
            aria-describedby="ceiling-hint"
            value={ceiling}
            onChange={(e) => setCeiling(e.target.value)}
          />
        </div>
        {offer.renegotiation_allowed ? (
          <div className="field">
            <label htmlFor="proposal">Offer a different price ({offer.currency}), optional</label>
            <p className="hint" id="proposal-hint">
              This publisher accepts offers
              {offer.floor_minor !== null
                ? ` from ${formatMinor(offer.floor_minor, offer.currency)}`
                : ''}
              .
            </p>
            <input
              id="proposal"
              type="text"
              inputMode="decimal"
              aria-describedby="proposal-hint"
              value={proposal}
              onChange={(e) => setProposal(e.target.value)}
            />
          </div>
        ) : null}
        <button className="btn btn-primary" type="submit" disabled={busy || !signedIn || !chosen}>
          {busy && result === null ? 'Checking' : 'Show my price'}
        </button>
      </form>

      <div aria-live="polite" data-testid="quote-result">
        {error ? <ErrorState title={refusal ?? 'Could not get a price'}>{error}</ErrorState> : null}
        {noMatch !== null ? (
          <StatusBanner tone="warn" title={noMatch.heading}>
            {noMatch.text}
            {noMatch.link ? (
              <>
                {' '}
                <Link href={noMatch.link.href}>{noMatch.link.text}</Link>
              </>
            ) : null}
          </StatusBanner>
        ) : null}
        {result?.kind === 'quote' ? (
          <section className="card" aria-labelledby="your-price">
            <h2 id="your-price">Your price</h2>
            <p>
              <strong className="price" data-testid="quote-price">
                {formatMinor(result.price.minor, result.price.currency)}
              </strong>{' '}
              for {OPTION_LABEL[result.option].toLowerCase()}, from {offer.publisher}.
            </p>
            <p className="muted">{OPTION_HELP[result.option]}</p>
            <TermsConsent
              id="offer-terms"
              label="I accept the terms of this purchase."
              checked={terms}
              onChange={setTerms}
              rights={offer.rights}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={identity}
                onChange={(e) => setIdentity(e.target.checked)}
              />
              <span>Share my name with the publisher on the receipt (optional).</span>
            </label>
            <div className="actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={review}
                disabled={!terms || busy}
              >
                Review and approve
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
