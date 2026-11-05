'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { postJson } from '../lib/client-api';
import {
  ASK_LABEL,
  ASK_MFA_TEXT,
  ASK_PLACEHOLDER,
  ASK_TEXT_MAX,
  askAllowed,
  askHref,
  askView,
} from '../lib/ask-view';
import type { BarContext, RawMap } from '../lib/filter-bar-view';

interface Answer {
  chips: Record<string, string>;
  dropped: string[];
}

// INT-GA / GA.2: the ask box inside the filter bar. The person's words go to POST /api/assist/query, which proposes
// chips and names what it dropped; the box shows them, the person removes any they do not want, and only "Apply"
// changes the page URL. Nothing runs before that. The words, chips and answer are shown as text only.
export function AskBox({
  ctx,
  raw,
  basePath,
}: {
  ctx: Extract<BarContext, { kind: 'txn' }>;
  raw: RawMap;
  basePath: string;
}) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [proposal, setProposal] = useState<Answer | null>(null);

  if (!askAllowed(ctx.persona))
    return (
      <p className="txn-note" data-testid="ask-mfa">
        {ASK_MFA_TEXT}
      </p>
    );

  const ask = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (text.trim() === '') {
      setProblem('Type a few words first.');
      return;
    }
    setBusy(true);
    setProblem('');
    const r = await postJson<Answer>('/api/assist/query', { text });
    setBusy(false);
    if (r.ok) setProposal(r.data);
    else {
      setProposal(null);
      setProblem(r.message);
    }
  };

  const remove = (field: string, value: string): void => {
    if (proposal === null) return;
    const chips = { ...proposal.chips };
    const left = (chips[field] ?? '').split(',').filter((v) => v !== value);
    if (left.length === 0) delete chips[field];
    else chips[field] = left.join(',');
    setProposal({ ...proposal, chips });
  };

  const view = proposal === null ? null : askView(ctx, proposal.chips, proposal.dropped);

  return (
    <div className="fb-ask" data-testid="ask-box">
      <form className="fb-add" aria-label={ASK_LABEL} onSubmit={ask}>
        <div>
          <label htmlFor="fb-ask-text">{ASK_LABEL}</label>
          <input
            id="fb-ask-text"
            type="text"
            autoComplete="off"
            maxLength={ASK_TEXT_MAX}
            placeholder={ASK_PLACEHOLDER}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Asking' : 'Ask'}
        </button>
      </form>
      {view !== null ? (
        <div data-testid="ask-proposal">
          <p className="txn-note">{view.note}</p>
          {view.chips.length > 0 ? (
            <ul aria-label="Proposed filters" data-testid="ask-chips">
              {view.chips.map((c) => (
                <li key={`${c.field}:${c.value}`} className="fb-chip">
                  <span>{c.text}</span>
                  <button
                    type="button"
                    className="btn"
                    aria-label={`Leave out ${c.text}`}
                    onClick={() => remove(c.field, c.value)}
                  >
                    Leave out
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {view.dropped !== '' ? (
            <p className="txn-note" data-testid="ask-dropped">
              {view.dropped}
            </p>
          ) : null}
          {view.chips.length > 0 ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => router.push(askHref(ctx, basePath, raw, proposal?.chips ?? {}))}
            >
              Apply these filters
            </button>
          ) : null}
        </div>
      ) : null}
      <p role="status" className={problem === '' ? 'visually-hidden' : 'fb-problem'}>
        {problem}
      </p>
    </div>
  );
}
