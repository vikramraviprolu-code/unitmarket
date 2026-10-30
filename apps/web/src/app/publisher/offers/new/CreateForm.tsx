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
import {
  HELP_ARTICLE,
  HELP_ATTEST_CREATE,
  SECTION_LICENCE,
  SECTION_PRICES,
  SECTION_REVIEW,
  SECTION_WHAT,
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
}

interface Problems {
  price: string | null;
  options: string | null;
  attest: string | null;
  form: string | null;
  bad: string[];
}

const NONE: Problems = { price: null, options: null, attest: null, form: null, bad: [] };

// PUB-E1: the create form. The body is the article id, the offered options with their prices in minor units
// and the tick. Nothing else leaves the browser: the publisher, the money unit, the terms and the licence are
// not editable and not sent. The route and the domain check everything again; this form spares a round trip.
// PUB-UI-FORMS: the fields sit in four sections, and each problem is shown beside its own field.
export function CreateForm({
  articles,
  capMinor,
  hint,
  prefix,
  attestLabel,
  rows,
  terms,
}: {
  articles: { id: string; title: string }[];
  capMinor: number;
  hint: string;
  /** The three letter code shown in front of each price. */
  prefix: string;
  attestLabel: string;
  rows: Row[];
  /** The sentence about the terms version, the access window and the licence. */
  terms: string;
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
      form: field === 'form' || field === 'reason' ? createErrorText(code) : null,
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setProblems(NONE);
    setDone(null);
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
    const res = await postJson<{ offer_id: string; version: string }>(
      '/api/publisher/offers/create',
      { article_id: article, options: got.options, attestation: attest },
    );
    setBusy(false);
    if (!res.ok) {
      if (res.status === 401) {
        setProblems({ ...NONE, form: 'Please sign in again.' });
        return;
      }
      const onSale = rows.filter((r) => offered[r.option] === true).map((r) => r.option);
      if (offerErrorField(res.code) === 'form') {
        setProblems({ ...NONE, form: createErrorText(res.code) });
      } else {
        show(res.code, offerErrorField(res.code) === 'price' ? onSale : []);
      }
      return;
    }
    setAttest(false);
    setDone(createdText(res.data.version));
    router.push(`/publisher/offers/${encodeURIComponent(res.data.offer_id)}`);
  }

  return (
    <form onSubmit={(e) => void save(e)} aria-label={CREATE_LABEL}>
      <Section title={SECTION_WHAT} id="create-what">
        <div className="pk-panel">
          <Field id="create-article" label={CREATE_ARTICLE_LABEL} help={HELP_ARTICLE}>
            {(a) => (
              <select {...a} value={article} onChange={(e) => setArticle(e.target.value)}>
                {articles.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </Section>
      <Section title={SECTION_PRICES} id="create-prices">
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
      <Section title={SECTION_LICENCE} id="create-licence">
        <div className="pk-panel">
          <p data-testid="create-terms">{terms}</p>
        </div>
      </Section>
      <Section title={SECTION_REVIEW} id="create-review">
        <div className="pk-panel">
          <AttestBox
            label={attestLabel}
            help={HELP_ATTEST_CREATE}
            checked={attest}
            onChange={setAttest}
            error={problems.attest}
          />
          <div className="pk-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !attest}>
              {CREATE_LABEL}
            </button>
          </div>
          <div aria-live="polite" data-testid="offer-create-result">
            {done}
          </div>
          {problems.form ? (
            <ErrorState title="Could not create the offer">{problems.form}</ErrorState>
          ) : null}
        </div>
      </Section>
    </form>
  );
}
