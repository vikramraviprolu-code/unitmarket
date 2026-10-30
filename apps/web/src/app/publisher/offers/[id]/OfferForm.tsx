'use client';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
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
import {
  HELP_ATTEST_SAVE,
  HELP_SAVE,
  SECTION_PRICES,
  SECTION_REVIEW,
  WITHDRAW_HELP,
  collectOptions,
  offerErrorField,
  optionHelp,
  priceHelp,
} from '../../../../lib/publisher-forms-copy';
import { ErrorState } from '../../../../ui/ErrorState';
import { Section } from '../../../../ui/publisher/kit';
import { AttestBox, Field, OptionRows } from '../../form-parts';

interface Row {
  option: 'keep_retrieve' | 'online_read';
  offeredLabel: string;
  priceLabel: string;
  optionName: string;
  offered: boolean;
  price: string;
}

interface Problems {
  price: string | null;
  options: string | null;
  attest: string | null;
  form: string | null;
  bad: string[];
}

const NONE: Problems = { price: null, options: null, attest: null, form: null, bad: [] };

// PUB-B: price and options of one offer. The body is the offer id, the version this page was opened at,
// the offered options with their prices in minor units and the tick. Nothing else leaves the browser:
// the publisher, the article, the terms and the access window are not editable and not sent. The route
// and the domain check everything again; this form only spares a round trip.
// PUB-UI-FORMS: the prices and the review sit in their own sections; the page passes the licence section
// between them as children. Each problem is shown beside its own field.
export function OfferForm({
  offerId,
  version,
  capMinor,
  hint,
  prefix,
  rows,
  children,
}: {
  offerId: string;
  version: string;
  capMinor: number;
  hint: string;
  /** The three letter code shown in front of each price. */
  prefix: string;
  rows: Row[];
  children?: ReactNode;
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
  const [problems, setProblems] = useState<Problems>(NONE);

  function show(code: string, bad: string[]) {
    const text = offerErrorText(code);
    const field = offerErrorField(code);
    setProblems({
      ...NONE,
      bad,
      price: field === 'price' ? text : null,
      options: field === 'options' ? text : null,
      attest: field === 'attest' ? text : null,
      form: field === 'form' || field === 'reason' ? text : null,
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setProblems(NONE);
    setSaved(null);
    const got = collectOptions(
      rows.map((r) => ({
        option: r.option,
        offered: offered[r.option] === true,
        price: prices[r.option] ?? '',
      })),
      capMinor,
      parsePriceMinor,
    );
    if (got.code !== null) {
      show(got.code, got.bad);
      return;
    }
    setBusy(true);
    const res = await postJson<{ version: string }>('/api/publisher/offers/revise', {
      offer_id: offerId,
      expected_version: version,
      options: got.options,
      attestation: attest,
    });
    setBusy(false);
    if (!res.ok) {
      if (res.status === 401) {
        setProblems({ ...NONE, form: 'Please sign in again.' });
        return;
      }
      const onSale = rows.filter((r) => offered[r.option] === true).map((r) => r.option);
      show(res.code, offerErrorField(res.code) === 'price' ? onSale : []);
      return;
    }
    setAttest(false);
    setSaved(savedText(res.data.version));
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void save(e)} aria-label={SAVE_LABEL}>
      <Section title={SECTION_PRICES} id="offer-prices">
        <div className="pk-panel">
          <OptionRows
            rows={rows}
            offered={offered}
            prices={prices}
            onOffered={(option, on) => setOffered({ ...offered, [option]: on })}
            onPrice={(option, text) => setPrices({ ...prices, [option]: text })}
            prefix={prefix}
            rangeHelp={priceHelp(hint)}
            help={optionHelp}
            bad={problems.bad}
            error={problems.price}
            optionsError={problems.options}
          />
        </div>
      </Section>
      {children}
      <Section title={SECTION_REVIEW} id="offer-review">
        <div className="pk-panel">
          <AttestBox
            label={ATTEST_LABEL}
            help={HELP_ATTEST_SAVE}
            checked={attest}
            onChange={setAttest}
            error={problems.attest}
          />
          <p className="pk-help">{HELP_SAVE}</p>
          <div className="pk-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !attest}>
              {SAVE_LABEL}
            </button>
          </div>
          <div aria-live="polite" data-testid="offer-save-result">
            {saved}
          </div>
          {problems.form ? <ErrorState title="Could not save">{problems.form}</ErrorState> : null}
        </div>
      </Section>
    </form>
  );
}

// PUB-B: withdraw. The body is the offer id, the version this page was opened at and the reason.
// PUB-UI-FORMS: a separate area at the foot of the page, marked as the one that cannot be undone here.
export function WithdrawForm({ offerId, version }: { offerId: string; version: string }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function withdraw(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setReasonError(null);
    const res = await postJson<{ version: string }>('/api/publisher/offers/withdraw', {
      offer_id: offerId,
      expected_version: version,
      reason,
    });
    setBusy(false);
    if (!res.ok) {
      if (res.status === 401) setError('Please sign in again.');
      else if (offerErrorField(res.code) === 'reason') setReasonError(offerErrorText(res.code));
      else setError(offerErrorText(res.code));
      return;
    }
    setDone(true);
    router.refresh();
  }

  return (
    <section className="pk-section pk-danger-zone" aria-labelledby="withdraw-heading">
      <h2 id="withdraw-heading">{WITHDRAW_HEADING}</h2>
      <div className="pk-panel pk-danger">
        <p>{WITHDRAW_LEDE}</p>
        <form onSubmit={(e) => void withdraw(e)}>
          <Field
            id="withdraw-reason"
            label={WITHDRAW_REASON_LABEL}
            help={WITHDRAW_HELP}
            error={reasonError}
          >
            {(a) => (
              <input
                {...a}
                type="text"
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          <div className="pk-actions">
            <button
              type="submit"
              className="btn pk-btn-danger"
              disabled={busy || reason.trim().length < 3}
            >
              {WITHDRAW_LABEL}
            </button>
          </div>
        </form>
        <div aria-live="polite" data-testid="offer-withdraw-result">
          {done ? WITHDRAWN_DONE : null}
        </div>
        {error ? <ErrorState title="Could not withdraw">{error}</ErrorState> : null}
      </div>
    </section>
  );
}
