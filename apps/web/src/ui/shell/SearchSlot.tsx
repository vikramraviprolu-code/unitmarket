'use client';
import { useEffect, useRef } from 'react';
import { showsQuickFind } from '../../lib/quick-find-view';
import type { ShellPersona } from '../../lib/shell-tabs';
import { QuickFind } from '../ops/QuickFind';

// INT-UI0 / UI0.1: a search field the keyboard can reach with "/". It takes focus. A slash typed into a field, a
// text area, a menu or an editable region stays a slash. INT-OPS-B / OPS-B.3 (B6): in the operator shell the
// field is quick-find (ui/ops/QuickFind.tsx); the buyer and seller shells keep the inert field below, which
// makes no request and goes nowhere.
export function SearchSlot({ persona }: { persona: ShellPersona }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const t = e.target instanceof HTMLElement ? e.target : null;
        const typing =
          t !== null &&
          (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.tagName === 'SELECT' ||
            t.isContentEditable);
        if (!typing) {
          e.preventDefault();
          field.current?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  if (showsQuickFind(persona)) return <QuickFind inputRef={field} />;
  return (
    <form
      className="shell-search"
      role="search"
      data-testid="shell-search"
      onSubmit={(e) => e.preventDefault()}
    >
      <label className="visually-hidden" htmlFor="shell-search-input">
        Search
      </label>
      <input
        id="shell-search-input"
        ref={field}
        type="search"
        autoComplete="off"
        placeholder="Search (press /)"
        data-testid="shell-search-input"
      />
    </form>
  );
}
