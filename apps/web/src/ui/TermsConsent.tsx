'use client';
import type { Rights } from '@umsbx/contracts';
import { TERMS_SUMMARY, termsPoints } from '../lib/buyer-copy';

// The terms, then the tick (UX-1A item 50). One component renders both, so a tick never exists without
// its terms in front of it. The terms are open when the page loads and the tick points at them.
export function TermsConsent({
  id,
  label,
  checked,
  onChange,
  rights,
  days,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  rights?: Rights | readonly Rights[];
  /** JR-1: the access window in force now; without it the registry default. */
  days?: number;
}) {
  const termsId = `${id}-text`;
  return (
    <>
      <details className="terms-more" open>
        <summary>{TERMS_SUMMARY}</summary>
        <ul id={termsId}>
          {termsPoints(rights, days).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </details>
      <label className="check">
        <input
          type="checkbox"
          checked={checked}
          aria-describedby={termsId}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{label}</span>
      </label>
    </>
  );
}
