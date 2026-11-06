'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../lib/client-api';
import {
  BEGIN_BUTTON,
  BEGIN_HEADING,
  BEGIN_LEDE,
  BEGIN_STARTED,
  BEGIN_URL_LABEL,
  DOMAIN_ADD_BUTTON,
  DOMAIN_CHECKED_OK,
  DOMAIN_CHECK_BUTTON,
  DOMAIN_HEADING,
  DOMAIN_HOST_LABEL,
  DOMAIN_HOW_FILE,
  DOMAIN_HOW_HEADING,
  DOMAIN_HOW_META,
  DOMAIN_LEDE,
  DOMAIN_TOKEN_HEADING,
  DOMAIN_TOKEN_NOTE,
  importErrorText,
} from '../../../lib/web-import-copy';
import { ErrorState } from '../../../ui/ErrorState';
import { Section } from '../../../ui/publisher/kit';
import { Field } from '../form-parts';

// POB-I1: step 1 (prove the address) and step 2 (start reading). The body of each call is the one field it
// needs; the routes check everything again. The code is shown once and kept only in this page's memory.
export function ImportStart({ pending, verified }: { pending: string[]; verified: string[] }) {
  const router = useRouter();
  const [host, setHost] = useState(pending[0] ?? '');
  const [token, setToken] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState(verified[0] ? `https://${verified[0]}/` : '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function run<T>(path: string, body: unknown, ok: (d: T) => void) {
    setBusy(true);
    setProblem(null);
    setNote(null);
    const res = await postJson<T>(path, body);
    setBusy(false);
    if (!res.ok) {
      setProblem(res.status === 401 ? 'Please sign in again.' : importErrorText(res.code));
      return;
    }
    ok(res.data);
  }

  function add(e: FormEvent) {
    e.preventDefault();
    void run<{ host: string; token: string | null }>(
      '/api/publisher/import/domains',
      { host },
      (d) => {
        setToken(d.token);
        router.refresh();
      },
    );
  }
  function check() {
    void run('/api/publisher/import/domains/check', { host }, () => {
      setToken(null);
      setNote(DOMAIN_CHECKED_OK);
      router.refresh();
    });
  }
  function begin(e: FormEvent) {
    e.preventDefault();
    void run<{ batch_id: string }>(
      '/api/publisher/import/begin',
      { source_url: sourceUrl },
      (d) => {
        setNote(BEGIN_STARTED);
        router.push(`/publisher/import/${encodeURIComponent(d.batch_id)}`);
      },
    );
  }

  return (
    <>
      <Section title={DOMAIN_HEADING} id="import-prove">
        <div className="pk-panel">
          <p>{DOMAIN_LEDE}</p>
          <form onSubmit={add} aria-label={DOMAIN_HEADING}>
            <Field id="import-host" label={DOMAIN_HOST_LABEL}>
              {(a) => (
                <input
                  {...a}
                  type="text"
                  autoComplete="off"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                />
              )}
            </Field>
            <div className="pk-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || host.trim() === ''}
              >
                {DOMAIN_ADD_BUTTON}
              </button>{' '}
              <button
                type="button"
                className="btn"
                disabled={busy || host.trim() === ''}
                onClick={check}
              >
                {DOMAIN_CHECK_BUTTON}
              </button>
            </div>
          </form>
          {token ? (
            <div data-testid="import-token">
              <h3>{DOMAIN_TOKEN_HEADING}</h3>
              <p>
                <code>{token}</code>
              </p>
              <p className="pk-help">{DOMAIN_TOKEN_NOTE}</p>
              <h3>{DOMAIN_HOW_HEADING}</h3>
              <ul>
                <li>{DOMAIN_HOW_META}</li>
                <li>{DOMAIN_HOW_FILE}</li>
              </ul>
            </div>
          ) : null}
        </div>
      </Section>
      <Section title={BEGIN_HEADING} id="import-begin">
        <div className="pk-panel">
          <p>{BEGIN_LEDE}</p>
          <form onSubmit={begin} aria-label={BEGIN_HEADING}>
            <Field id="import-url" label={BEGIN_URL_LABEL}>
              {(a) => (
                <input
                  {...a}
                  type="text"
                  autoComplete="off"
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                />
              )}
            </Field>
            <div className="pk-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || sourceUrl.trim() === ''}
              >
                {BEGIN_BUTTON}
              </button>
            </div>
          </form>
        </div>
      </Section>
      <div aria-live="polite" data-testid="import-result">
        {note}
      </div>
      {problem ? <ErrorState title="Could not do that">{problem}</ErrorState> : null}
    </>
  );
}
