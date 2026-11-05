'use client';
import { useEffect, useRef } from 'react';

// INT-UI0 / UI0.1: a search field the keyboard can reach with "/". It takes focus and does nothing else: no
// request, no navigation. Search itself arrives with OPS-B, which gives the form something to submit. A slash
// typed into a field, a text area, a menu or an editable region stays a slash.
export function SearchSlot() {
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
