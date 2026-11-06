'use client';
import { useCallback, useEffect, useState } from 'react';
import { getJson, postJson } from '../../../../lib/client-api';
import { formatMinor } from '../../../../lib/format';
import { parsePriceMinor, priceInputValue } from '../../../../lib/offer-copy';
import {
  ATTEST_LABEL,
  BUYER_PRICE_NOTE,
  COL_BUYER_PRICE,
  COL_KIND,
  COL_PRICE,
  COL_STATE,
  COL_TITLE,
  HIDE_LABEL,
  ITEMS_EMPTY,
  KIND_ARTICLE,
  KIND_IMAGE,
  NO_PRICE,
  PRICE_HELP,
  PUBLISHED_DONE,
  PUBLISH_BUTTON,
  PUBLISH_HEADING,
  PUBLISH_LEDE,
  SAVE_BUTTON,
  batchNoteText,
  batchStateText,
  importErrorText,
  itemReasonText,
  itemStateText,
  progressText,
  publishedText,
} from '../../../../lib/web-import-copy';
import { ErrorState } from '../../../../ui/ErrorState';
import { Chip, Section } from '../../../../ui/publisher/kit';

interface Batch {
  id: string;
  state: string;
  note: string | null;
  total: number;
  done: number;
  refused: number;
  attested: boolean;
}
interface Item {
  id: string;
  kind: 'article' | 'image';
  title: string;
  price_minor: number | null;
  currency: string | null;
  buyer_price_minor: number | null;
  state: string;
  reason: string | null;
}
interface View {
  batch: Batch;
  items: Item[];
}

// POB-I1: the progress of a running batch (polled every 2 seconds until it ends) and the review list. A row
// sends the id and the changed fields only; the price is typed in major units and sent in minor units.
export function ReviewList({ initial, offerMaxMinor }: { initial: View; offerMaxMinor: number }) {
  const [view, setView] = useState<View>(initial);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [attest, setAttest] = useState(initial.batch.attested);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await getJson<View>(
      `/api/publisher/import/status?batch=${encodeURIComponent(initial.batch.id)}`,
    );
    if (res.ok) setView({ batch: res.data.batch, items: res.data.items });
  }, [initial.batch.id]);

  const running = view.batch.state === 'queued' || view.batch.state === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 2000);
    return () => clearInterval(t);
  }, [running, reload]);

  async function save(item: Item, hidden?: boolean) {
    setProblem(null);
    const body: Record<string, unknown> = { item_id: item.id };
    const title = titles[item.id];
    if (title !== undefined && title !== item.title) body['title'] = title;
    const typed = prices[item.id];
    if (typed !== undefined && typed.trim() !== '') {
      const minor = parsePriceMinor(typed);
      if (minor === null || minor < 1 || minor > offerMaxMinor) {
        setProblem(importErrorText('invalid_price'));
        return;
      }
      if (minor !== item.price_minor) body['price_minor'] = minor;
    }
    if (hidden !== undefined) body['hidden'] = hidden;
    if (Object.keys(body).length === 1) return;
    setBusy(true);
    const res = await postJson('/api/publisher/import/items', body);
    setBusy(false);
    if (!res.ok) {
      setProblem(res.status === 401 ? 'Please sign in again.' : importErrorText(res.code));
      return;
    }
    await reload();
  }

  async function publish() {
    setProblem(null);
    setDone(null);
    setBusy(true);
    const res = await postJson<{ published: number }>('/api/publisher/import/publish', {
      batch_id: view.batch.id,
      attestation: attest,
    });
    setBusy(false);
    if (!res.ok) {
      setProblem(res.status === 401 ? 'Please sign in again.' : importErrorText(res.code));
      return;
    }
    setDone(`${PUBLISHED_DONE} ${publishedText(res.data.published)}`);
    await reload();
  }

  const b = view.batch;
  return (
    <>
      <Section id="import-progress">
        <p data-testid="import-progress">
          <Chip tone={b.state === 'done' ? 'good' : b.state === 'failed' ? 'bad' : 'info'}>
            {batchStateText(b.state)}
          </Chip>{' '}
          {progressText(b.done, b.total, b.refused)}
        </p>
        {b.note ? <p className="pk-help">{batchNoteText(b.note)}</p> : null}
      </Section>
      <Section id="import-items">
        {view.items.length === 0 ? (
          <p>{ITEMS_EMPTY}</p>
        ) : (
          <div className="pk-table-wrap">
            <table className="pk-table">
              <thead>
                <tr>
                  <th scope="col">{COL_TITLE}</th>
                  <th scope="col">{COL_KIND}</th>
                  <th scope="col">{COL_PRICE}</th>
                  <th scope="col">{COL_BUYER_PRICE}</th>
                  <th scope="col">{COL_STATE}</th>
                  <th scope="col">
                    <span className="visually-hidden">{SAVE_BUTTON}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.items.map((i) => {
                  const editable = i.state === 'staged' || i.state === 'hidden';
                  return (
                    <tr key={i.id}>
                      <td>
                        {editable ? (
                          <input
                            type="text"
                            aria-label={COL_TITLE}
                            value={titles[i.id] ?? i.title}
                            maxLength={200}
                            onChange={(e) => setTitles({ ...titles, [i.id]: e.target.value })}
                          />
                        ) : (
                          i.title
                        )}
                      </td>
                      <td>{i.kind === 'image' ? KIND_IMAGE : KIND_ARTICLE}</td>
                      <td>
                        {editable ? (
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label={COL_PRICE}
                            placeholder={NO_PRICE}
                            title={PRICE_HELP}
                            value={
                              prices[i.id] ??
                              (i.price_minor === null ? '' : priceInputValue(i.price_minor))
                            }
                            onChange={(e) => setPrices({ ...prices, [i.id]: e.target.value })}
                          />
                        ) : i.price_minor !== null && i.currency !== null ? (
                          formatMinor(i.price_minor, i.currency)
                        ) : (
                          ''
                        )}
                      </td>
                      <td>
                        {i.buyer_price_minor !== null && i.currency !== null
                          ? formatMinor(i.buyer_price_minor, i.currency)
                          : ''}
                      </td>
                      <td>
                        {itemStateText(i.state)}
                        {i.reason ? (
                          <span className="pk-help"> {itemReasonText(i.reason)}</span>
                        ) : null}
                      </td>
                      <td>
                        {editable ? (
                          <>
                            <button
                              type="button"
                              className="btn"
                              disabled={busy}
                              onClick={() => void save(i)}
                            >
                              {SAVE_BUTTON}
                            </button>{' '}
                            <label>
                              <input
                                type="checkbox"
                                checked={i.state === 'hidden'}
                                disabled={busy}
                                onChange={(e) => void save(i, e.target.checked)}
                              />{' '}
                              {HIDE_LABEL}
                            </label>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="pk-help">{BUYER_PRICE_NOTE}</p>
      </Section>
      <Section title={PUBLISH_HEADING} id="import-publish">
        <div className="pk-panel">
          <p>{PUBLISH_LEDE}</p>
          <label>
            <input
              type="checkbox"
              checked={attest}
              disabled={b.attested}
              onChange={(e) => setAttest(e.target.checked)}
            />{' '}
            {ATTEST_LABEL}
          </label>
          <div className="pk-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || running || !attest}
              onClick={() => void publish()}
            >
              {PUBLISH_BUTTON}
            </button>
          </div>
          <div aria-live="polite" data-testid="import-publish-result">
            {done}
          </div>
        </div>
      </Section>
      {problem ? <ErrorState title="Could not do that">{problem}</ErrorState> : null}
    </>
  );
}
