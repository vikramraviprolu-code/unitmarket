// requestIdFor: prefixes umsC-, umsK-, umsR-; at most 108 characters (the adapter's limit).
import { describe, expect, it } from 'vitest';
import { requestIdFor } from './index';

describe('requestIdFor lengths and prefixes', () => {
  const ref = 'ord_0123456789ABCDEFGHJKMNPQRS';
  it('create is umsC-<ref>', () => expect(requestIdFor('create', ref)).toBe(`umsC-${ref}`));
  it('capture is umsK-<ref>', () => expect(requestIdFor('capture', ref)).toBe(`umsK-${ref}`));
  it('refund is umsR-<ref>', () => expect(requestIdFor('refund', ref)).toBe(`umsR-${ref}`));
  it('the three kinds differ for one ref', () => {
    const all = new Set([
      requestIdFor('create', ref),
      requestIdFor('capture', ref),
      requestIdFor('refund', ref),
    ]);
    expect(all.size).toBe(3);
  });
  it('a real id gives a short key, well under 108', () => {
    expect(requestIdFor('capture', ref).length).toBe(ref.length + 5);
  });
  it('exactly 108 characters is allowed', () => {
    const r = 'x'.repeat(103);
    expect(requestIdFor('create', r)).toHaveLength(108);
  });
  it('109 characters is refused', () => {
    expect(() => requestIdFor('create', 'x'.repeat(104))).toThrow(/108/);
  });
  it('an empty ref is refused', () => {
    expect(() => requestIdFor('create', '')).toThrow();
  });
  it('is deterministic: the same ref gives the same key every time', () => {
    expect(requestIdFor('capture', ref)).toBe(requestIdFor('capture', ref));
  });
});
