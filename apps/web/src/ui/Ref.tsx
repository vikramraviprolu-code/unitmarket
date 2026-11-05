'use client';
import { useState } from 'react';
import { copyText, displayRef, type RefForm } from '../lib/ref-format';
import './shared-parts.css';

// INT-UI0 / UI0.4: an order reference in its one display form, with a copy control. The screen shows the short
// form by default; the copy control always copies the whole reference, and a screen reader reads the whole
// reference too. A value that is not a plausible reference draws nothing. The words are plain and the
// result is announced in a polite status region.
export function Ref({ value, form = 'short' }: { value: string; form?: RefForm }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const shown = displayRef(value, form);
  const text = copyText(value);
  if (shown === '' || text === '') return null;
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return (
    <span className="ref" data-testid="ref">
      <code aria-hidden="true" title={text}>
        {shown}
      </code>
      <span className="visually-hidden">{text}</span>
      <button type="button" className="ref-copy" onClick={() => void copy()}>
        Copy
        <span className="visually-hidden"> order reference</span>
      </button>
      <span className="ref-status" role="status">
        {state === 'copied'
          ? 'Copied.'
          : state === 'failed'
            ? 'Could not copy. Select the reference instead.'
            : ''}
      </span>
    </span>
  );
}
