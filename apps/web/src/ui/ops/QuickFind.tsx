'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { getJson } from '../../lib/client-api';
import { findUrl, quickFindView } from '../../lib/quick-find-view';
import type { FindAnswer, QuickFindView } from '../../lib/quick-find-view';
import './ops-b.css';

// INT-OPS-B / OPS-B.3: quick-find in the operator shell. "/" focuses the field (SearchSlot), a short ref lists the
// hits, Enter opens the first order. Two actions: "/" and Enter. The typed text goes to GET /api/ops/find and
// nowhere else: it is not logged, stored or kept after the field is cleared.
export function QuickFind({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [view, setView] = useState<QuickFindView | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  const lookup = async (q: string): Promise<QuickFindView | null> => {
    const url = findUrl(q);
    const mine = ++latest.current;
    if (url === null) {
      setView(null);
      setFailed(false);
      return null;
    }
    const r = await getJson<FindAnswer>(url);
    if (mine !== latest.current) return null;
    if (!r.ok) {
      setFailed(true);
      setView(null);
      return null;
    }
    // The route includes the buyers group only for a session with MFA.
    const v = quickFindView(r.data, { mfa: r.data.buyers !== undefined });
    setFailed(false);
    setView(v);
    return v;
  };

  useEffect(() => {
    const t = setTimeout(() => void lookup(text), 250);
    return () => clearTimeout(t);
  }, [text]);

  const submit = async (): Promise<void> => {
    const v = await lookup(text);
    if (v?.firstOrderHref) {
      setText('');
      setView(null);
      router.push(v.firstOrderHref);
    }
  };

  return (
    <form
      className="shell-search"
      role="search"
      data-testid="shell-search"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setText('');
          setView(null);
        }
      }}
    >
      <label className="visually-hidden" htmlFor="shell-search-input">
        Search
      </label>
      <input
        id="shell-search-input"
        ref={inputRef}
        type="search"
        autoComplete="off"
        placeholder="Find an order, seller or key (press /)"
        aria-describedby="qf-hint"
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid="shell-search-input"
      />
      <p id="qf-hint" className="visually-hidden">
        Type at least two characters. Press Enter to open the first order.
      </p>
      {view !== null || failed ? (
        <section
          className="qf-results"
          aria-label="Quick find results"
          data-testid="quick-find-results"
        >
          <p role="status" aria-live="polite" className="visually-hidden">
            {failed ? 'Search failed.' : view?.empty ? 'Nothing found.' : 'Results are ready.'}
          </p>
          {failed ? <p role="alert">The search could not be run. Try again in a moment.</p> : null}
          {view?.empty ? <p>{view.emptyText}</p> : null}
          {view?.groups.map((g) => (
            <div key={g.id}>
              <h2>{g.label}</h2>
              <ul aria-label={g.label}>
                {g.items.map((it, i) => (
                  <li key={it.key} data-first={g.id === 'orders' && i === 0 ? 'true' : undefined}>
                    <Link
                      href={it.href}
                      onClick={() => {
                        setText('');
                        setView(null);
                      }}
                    >
                      {it.label}
                      <span className="qf-detail">{it.detail}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
    </form>
  );
}
