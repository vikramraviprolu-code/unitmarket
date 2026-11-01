// WEB-THEME: the id of a legal section is made from its heading, so the tabs and the sections always agree.
import { describe, expect, it } from 'vitest';
import { LEGAL_DOCS } from '../lib/legal-copy';
import { legalSectionIds, sectionSlug } from './section-id';

describe('sectionSlug', () => {
  it('lower cases, joins words with one hyphen and drops punctuation', () => {
    expect(sectionSlug('Price and terms are held for 15 minutes')).toBe(
      'price-and-terms-are-held-for-15-minutes',
    );
    expect(sectionSlug("What we don't do!  (really)")).toBe('what-we-dont-do-really');
  });
  it('never returns an empty id', () => {
    expect(sectionSlug('???')).toBe('section');
  });
});

describe('legalSectionIds', () => {
  it('gives every section of every legal page a unique, valid id', () => {
    for (const doc of LEGAL_DOCS) {
      const ids = legalSectionIds(doc.sections.map((s) => s.heading));
      expect(ids).toHaveLength(doc.sections.length);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
  it('suffixes a repeated heading', () => {
    expect(legalSectionIds(['Contact', 'Contact'])).toEqual(['contact', 'contact-2']);
  });
});
