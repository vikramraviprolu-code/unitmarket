'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../lib/client-api';
import {
  QUICK_BUTTON,
  QUICK_COPIED,
  QUICK_COPY,
  QUICK_DOWNLOAD,
  QUICK_FILE_WHERE,
  QUICK_GAVE_UP,
  QUICK_HEADING,
  QUICK_LEDE,
  QUICK_META_OR,
  QUICK_NEW_CODE,
  QUICK_PROVE_HEADING,
  QUICK_STARTED,
  QUICK_URL_LABEL,
  QUICK_WAITING,
  importErrorText,
} from '../../../lib/web-import-copy';
import { ErrorState } from '../../../ui/ErrorState';
import { Section } from '../../../ui/publisher/kit';
import { Field } from '../form-parts';

type QuickStep =
  | {
      step: 'prove';
      host: string;
      token: string;
      file_path: string;
      file_body: string;
      meta_tag: string;
    }
  | { step: 'waiting'; host: string; detail?: string }
  | { step: 'started'; host: string; batch_id: string };

/** Every 5 seconds, at most 120 times (10 minutes); the route allows 12 calls a minute. */
const POLL_MS = 5000;
const MAX_POLLS = 120;

// POB-Q1: one address. The first answer gives the proof file (downloaded from memory, never stored) and the
// tag; the page then asks again every 5 seconds until the site is proved and the import has started, and opens
// the review list of that import. The code lives only in this page's memory, as in step 1.
export function QuickStart() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [proof, setProof] = useState<Extract<QuickStep, { step: 'prove' }> | null>(null);
  const [polling, setPolling] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const polls = useRef(0);

  const send = useCallback(
    async (newCode: boolean): Promise<void> => {
      const res = await postJson<QuickStep>('/api/publisher/import/quick', {
        source_url: url.trim(),
        ...(newCode ? { new_code: true } : {}),
      });
      if (!res.ok) {
        setPolling(false);
        setProblem(res.status === 401 ? 'Please sign in again.' : importErrorText(res.code));
        return;
      }
      const d = res.data;
      if (d.step === 'prove') {
        setProof(d);
        polls.current = 0;
        setGaveUp(false);
        setPolling(true);
      } else if (d.step === 'waiting') {
        setPolling(true);
      } else {
        setPolling(false);
        setNote(QUICK_STARTED);
        router.push(`/publisher/import/${encodeURIComponent(d.batch_id)}`);
      }
    },
    [url, router],
  );

  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => {
      polls.current += 1;
      if (polls.current > MAX_POLLS) {
        setPolling(false);
        setGaveUp(true);
        return;
      }
      void send(false);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [polling, send]);

  async function start(e: { preventDefault(): void }, newCode = false) {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    setNote(null);
    setGaveUp(false);
    polls.current = 0;
    await send(newCode);
    setBusy(false);
  }

  function download() {
    if (proof === null) return;
    const blob = new Blob([proof.file_body], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'unitmarket-verify.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function copyTag() {
    if (proof === null) return;
    try {
      await navigator.clipboard.writeText(proof.meta_tag);
      setNote(QUICK_COPIED);
    } catch {
      /* the tag stays on screen to copy by hand */
    }
  }

  return (
    <Section title={QUICK_HEADING} id="import-quick">
      <div className="pk-panel">
        <p>{QUICK_LEDE}</p>
        <form onSubmit={(e) => void start(e)} aria-label={QUICK_HEADING}>
          <Field id="import-quick-url" label={QUICK_URL_LABEL}>
            {(a) => (
              <input
                {...a}
                type="url"
                autoComplete="off"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            )}
          </Field>
          <div className="pk-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || url.trim() === ''}>
              {QUICK_BUTTON}
            </button>
          </div>
        </form>
        {proof ? (
          <div data-testid="import-quick-proof">
            <h3>{QUICK_PROVE_HEADING}</h3>
            <div className="pk-actions">
              <button type="button" className="btn btn-primary" onClick={download}>
                {QUICK_DOWNLOAD}
              </button>
            </div>
            <p>
              {QUICK_FILE_WHERE}{' '}
              <code>
                https://{proof.host}
                {proof.file_path}
              </code>
            </p>
            <p className="pk-help">{QUICK_META_OR}</p>
            <p>
              <code>{proof.meta_tag}</code>{' '}
              <button type="button" className="btn" onClick={() => void copyTag()}>
                {QUICK_COPY}
              </button>
            </p>
            <div className="pk-actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={(e) => void start(e, true)}
              >
                {QUICK_NEW_CODE}
              </button>
            </div>
          </div>
        ) : null}
        <div aria-live="polite" data-testid="import-quick-status">
          {polling ? QUICK_WAITING : gaveUp ? QUICK_GAVE_UP : note}
        </div>
        {problem ? <ErrorState title="Could not do that">{problem}</ErrorState> : null}
      </div>
    </Section>
  );
}
