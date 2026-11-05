// INT-UI0 / UI0.4: one display form for an order reference. The component (ui/Ref.tsx) shows what
// lib/ref-format.ts returns and copies what copyText returns, which is the full reference.
import { describe, expect, it } from 'vitest';
import { copyText, displayRef, isRef, shortRef } from './lib/ref-format';

const FULL = 'ord_0194f3a2b7c84d1e9a5f66b0c1d2e3a4';

describe('the one display form', () => {
  it('the short ref is the last 6 characters', () => {
    expect(shortRef(FULL)).toBe('d2e3a4');
  });
  it('is written with a leading ellipsis, so it cannot be mistaken for a whole reference', () => {
    expect(displayRef(FULL)).toBe('\u2026d2e3a4');
    expect(displayRef(FULL, 'short')).toBe(displayRef(FULL));
  });
  it('the full form is the reference unchanged', () => {
    expect(displayRef(FULL, 'full')).toBe(FULL);
  });
  it('a reference of 6 characters or fewer is its own short form', () => {
    expect(shortRef('abc123')).toBe('abc123');
    expect(displayRef('abc123')).toBe('abc123');
    expect(displayRef('ab')).toBe('ab');
  });
  it('copy text equals the full reference, whichever form is on screen', () => {
    expect(copyText(FULL)).toBe(FULL);
    expect(copyText(FULL)).not.toBe(displayRef(FULL));
  });
});

describe('what counts as a reference', () => {
  it('accepts ids as the engine writes them', () => {
    expect(isRef(FULL)).toBe(true);
    expect(isRef('ord_1')).toBe(true);
  });
  it.each(['', '   ', 'ord 1', 'ord_1\n', 'ord_‮1', 'x'.repeat(201), ' ord_1'])(
    'refuses %j: nothing is shown or copied',
    (bad) => {
      expect(isRef(bad)).toBe(false);
      expect(displayRef(bad)).toBe('');
      expect(shortRef(bad)).toBe('');
      expect(copyText(bad)).toBe('');
    },
  );
  it('no dash character appears in the display forms', () => {
    expect(displayRef(FULL)).not.toMatch(/[‒-―]/);
  });
});
